// Screenshot editor: annotate + blur on a real screenshot, then prove the original is untouched, the exported copy is flattened,
// the redacted pixels are really gone, and the unredacted original only leaves the device when explicitly requested.
import { launch, keyInfo, newReporter, rmProfile, sleep, startSite, tmpProfile } from './lib.mjs';
import { unzipSync, strFromU8 } from 'fflate';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PORT = 4177;
const server = await startSite(PORT);
const rep = newReporter();
const ok = rep.ok;
const userData = tmpProfile();
const { ctx, rd, setSettings, dump, until, activeTabId } = await launch(userData);
const out = mkdtempSync(path.join(tmpdir(), 'rd-ann-'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const colors = (file, crop) => Number(execFileSync('convert', [file, '-crop', crop, '+repage', '-format', '%k', 'info:']).toString());

try {
  await setSettings({ replaySec: 30, tailSec: 0, preSessionSec: 0, openReviewAfterSave: false, markerScreenshot: false, fps: 10, bitrateKbps: 1000 });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`);
  await page.bringToFront();
  await rd((id) => self.__rd.armTab(id), await activeTabId());
  await sleep(2500);
  await rd(() => self.__rd.startRepro());
  await sleep(500);
  await rd(() => self.__rd.screenshot());
  const shot = await until(async () => (await dump('shots'))[0], 8000);
  ok('screenshot captured for the editor test', !!shot);
  await rd(() => self.__rd.finishRepro());
  const sess = (await dump('sessions')).find((s) => s.kind === 'repro');

  const rv = await ctx.newPage();
  await rv.setViewportSize({ width: 1300, height: 900 });
  await rv.goto(`chrome-extension://${keyInfo.id}/review.html?session=${sess.id}`);
  await rv.waitForSelector('[data-edit="0"]');
  const readOrig = () => rv.evaluate(async (f) => { const h = await (await navigator.storage.getDirectory()).getDirectoryHandle('shots'); const file = await (await h.getFileHandle(f.split('/')[1])).getFile(); return [...new Uint8Array(await file.arrayBuffer())]; }, shot.file);
  const origBefore = Buffer.from(await readOrig());

  await rv.click('[data-edit="0"]');
  await rv.waitForSelector('.editor #ed-canvas');
  const box = await rv.locator('#ed-canvas').boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const drag = async (a, b) => { await rv.mouse.move(...at(...a)); await rv.mouse.down(); await rv.mouse.move(...at(...b), { steps: 8 }); await rv.mouse.up(); };
  await rv.click('[data-tool="blur"]');
  await drag([0.02, 0.10], [0.45, 0.30]); // covers the shop header / first product text
  await rv.click('[data-tool="arrow"]');
  await drag([0.55, 0.55], [0.8, 0.35]);
  await rv.click('[data-tool="text"]');
  await rv.mouse.click(...at(0.1, 0.7));
  await rv.keyboard.type('Bug is here');
  await rv.keyboard.press('Enter');
  await rv.click('[data-tool="redact"]');
  await drag([0.6, 0.75], [0.9, 0.85]);
  // undo + redo must work on the whole layer
  await rv.keyboard.press('Control+z');
  await rv.keyboard.press('Control+Shift+z');
  if (process.env.ED_SHOT) await rv.screenshot({ path: process.env.ED_SHOT });
  await rv.click('#ed-save');
  await rv.waitForSelector('.editor', { state: 'detached' });
  const saved = (await dump('shots'))[0];
  ok('annotation layer is stored with the screenshot', saved.annotations.length === 4, saved.annotations.map((a) => a.type).join(','));
  ok('blur, arrow, text and redact are all present', ['blur', 'arrow', 'text', 'redact'].every((t) => saved.annotations.some((a) => a.type === t)));
  ok('text annotation kept its content', saved.annotations.find((a) => a.type === 'text')?.text === 'Bug is here', JSON.stringify(saved.annotations.find((a) => a.type === 'text')));
  ok('gallery marks the screenshot as Redacted', /redacted/i.test(await rv.locator('.gallery').innerText()));
  const origAfter = Buffer.from(await readOrig());
  ok('the ORIGINAL screenshot is byte-for-byte untouched', sha(origAfter) === sha(origBefore));

  // export 1: ZIP without originals
  const dl = [];
  rv.on('download', (d) => dl.push(d));
  await rv.evaluate(() => document.querySelectorAll('[data-fmt]').forEach((c) => (c.checked = c.dataset.fmt === 'zip' || c.dataset.fmt === 'html')));
  await rv.click('#export');
  await until(async () => dl.length >= 2, 20000);
  const zipD = dl.find((d) => d.suggestedFilename().endsWith('.zip'));
  const zp = path.join(out, 'a.zip'); await zipD.saveAs(zp);
  const z = unzipSync(new Uint8Array(readFileSync(zp)));
  const derivName = Object.keys(z).find((n) => /^screenshots\/[^/]+\.png$/.test(n));
  ok('ZIP carries the flattened derivative', !!derivName);
  ok('ZIP does NOT contain unredacted originals by default', !Object.keys(z).some((n) => n.startsWith('screenshots/originals/')));
  const man = JSON.parse(strFromU8(z['manifest.json']));
  ok('manifest records the redaction and that no original left the device', man.screenshots[0].redacted === true && man.screenshots[0].original_included === false);
  const sj = JSON.parse(strFromU8(z['session.json']));
  ok('session.json keeps the editable annotation model', sj.screenshots[0].annotations.length === 4 && sj.screenshots[0].redacted === true);
  const origFile = path.join(out, 'orig.png'), derivFile = path.join(out, 'deriv.png');
  writeFileSync(origFile, origAfter); writeFileSync(derivFile, z[derivName]);
  ok('derivative differs from the original', sha(z[derivName]) !== sha(origAfter));
  const [iw, ih] = execFileSync('identify', ['-format', '%w %h', origFile]).toString().split(' ').map(Number);
  const cropBlur = `${Math.round(iw * 0.38)}x${Math.round(ih * 0.14)}+${Math.round(iw * 0.05)}+${Math.round(ih * 0.13)}`;
  const co = colors(origFile, cropBlur), cd = colors(derivFile, cropBlur);
  ok('blurred region lost its detail (mosaic: far fewer distinct colours)', cd * 3 < co, `original ${co} colours -> derivative ${cd}`);
  const cropRedact = `${Math.round(iw * 0.25)}x${Math.round(ih * 0.06)}+${Math.round(iw * 0.65)}+${Math.round(ih * 0.77)}`;
  ok('redacted region is a solid box', colors(derivFile, cropRedact) <= 2, `${colors(derivFile, cropRedact)} colours`);
  const html = strFromU8(z['report.html']);
  ok('HTML report in the ZIP references the derivative, not an original', !html.includes('originals/'));
  const htmlD = dl.find((d) => d.suggestedFilename().endsWith('.html'));
  const hp = path.join(out, 'a.html'); await htmlD.saveAs(hp);
  const embedded = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(readFileSync(hp, 'utf8'))?.[1];
  ok('standalone HTML embeds the flattened derivative', !!embedded && sha(Buffer.from(embedded, 'base64')) === sha(z[derivName]));

  // export 2: explicit opt-in for originals
  dl.length = 0;
  await rv.evaluate(() => { document.querySelectorAll('[data-fmt]').forEach((c) => (c.checked = c.dataset.fmt === 'zip')); const i = document.getElementById('inc-orig'); i.checked = true; });
  await rv.click('#export');
  await until(async () => dl.length >= 1, 20000);
  const zp2 = path.join(out, 'b.zip'); await dl[0].saveAs(zp2);
  const z2 = unzipSync(new Uint8Array(readFileSync(zp2)));
  const on = Object.keys(z2).find((n) => n.startsWith('screenshots/originals/'));
  ok('with the explicit switch, the original is included and identical', !!on && sha(z2[on]) === sha(origAfter));
  ok('manifest then says the original was included', JSON.parse(strFromU8(z2['manifest.json'])).screenshots[0].original_included === true);

  // revert
  await rv.click('[data-edit="0"]');
  await rv.waitForSelector('.editor #ed-canvas');
  rv.once('dialog', (d) => d.accept());
  await rv.click('#ed-reset');
  await rv.click('#ed-save');
  await rv.waitForSelector('.editor', { state: 'detached' });
  ok('Revert to original clears the layer', (await dump('shots'))[0].annotations.length === 0);
  ok('the original still has the same bytes after the whole round trip', sha(Buffer.from(await readOrig())) === sha(origBefore));
} catch (e) {
  console.error('annotate e2e aborted:', e instanceof Error ? e.stack : e);
  rep.fail();
} finally {
  await ctx.close().catch(() => undefined);
  server.close();
  rmProfile(userData);
  process.exit(rep.summary() ? 1 : 0);
}
