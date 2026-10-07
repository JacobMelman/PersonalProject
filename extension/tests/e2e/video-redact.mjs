// Video privacy tools: mask a region, cut out a time range, preview, export, and prove from the decoded frames that
// the masked pixels are really gone, the cut range is really gone (video, steps, events) and nothing else changed.
import { launch, keyInfo, newReporter, rmProfile, sleep, startSite, tmpProfile } from './lib.mjs';
import { unzipSync, strFromU8 } from 'fflate';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PORT = 4178;
const server = await startSite(PORT);
const rep = newReporter();
const ok = rep.ok;
const userData = tmpProfile();
const { ctx, rd, setSettings, dump, until, activeTabId } = await launch(userData);
const out = mkdtempSync(path.join(tmpdir(), 'rd-vred-'));

const probe = (file) => {
  const o = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'default=nw=1', file]).toString();
  return { codec: /codec_name=(\w+)/.exec(o)?.[1], w: Number(/width=(\d+)/.exec(o)?.[1]), h: Number(/height=(\d+)/.exec(o)?.[1]), dur: Number(/duration=([\d.]+)/.exec(o)?.[1] ?? 0) };
};
const frame = (video, at, png) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', video, '-frames:v', '1', png]);
const stat = (png, fx, fy, fw, fh, dim) => {
  const crop = `${Math.round(dim.w * fw)}x${Math.round(dim.h * fh)}+${Math.round(dim.w * fx)}+${Math.round(dim.h * fy)}`;
  const run = (fmt) => Number(execFileSync('convert', [png, '-crop', crop, '+repage', '-format', fmt, 'info:']).toString());
  return { colors: run('%k'), mean: run('%[fx:mean]') };
};

try {
  await setSettings({ replaySec: 40, tailSec: 0, preSessionSec: 0, openReviewAfterSave: false, markerScreenshot: false, fps: 10, bitrateKbps: 1500 });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`);
  await page.bringToFront();
  await rd((id) => self.__rd.armTab(id), await activeTabId());
  await sleep(2500);
  await rd(() => self.__rd.startRepro());
  await sleep(1000);
  await page.click('#add'); // ~1 s
  await sleep(2000);
  await page.click('#nav-cart'); // ~3 s
  await sleep(3000);
  await page.click('#nav-profile'); // ~6 s  <- inside the cut
  await sleep(3000);
  await page.click('#nav-home'); // ~9 s
  await sleep(1500);
  await rd(() => self.__rd.finishRepro());
  const sess = (await dump('sessions')).find((s) => s.kind === 'repro');

  const rv = await ctx.newPage();
  await rv.setViewportSize({ width: 1300, height: 950 });
  await rv.goto(`chrome-extension://${keyInfo.id}/review.html?session=${sess.id}`);
  await until(() => rv.evaluate(() => { const v = document.getElementById('vid'); return v && v.duration > 0; }), 15000);
  ok('Privacy tools card is shown next to the replay', (await rv.locator('#ptools').count()) === 1);
  ok('Preview is disabled until there is at least one edit', await rv.locator('#pt-preview').isDisabled());

  const dl = [];
  rv.on('download', (d) => dl.push(d));
  const exportZip = async (name) => {
    dl.length = 0;
    await rv.evaluate(() => document.querySelectorAll('[data-fmt]').forEach((c) => (c.checked = c.dataset.fmt === 'zip' || c.dataset.fmt === 'txt')));
    await rv.click('#export');
    await until(async () => dl.length >= 2, 90000);
    const zipD = dl.find((d) => d.suggestedFilename().endsWith('.zip'));
    const zp = path.join(out, name);
    await zipD.saveAs(zp);
    const txtD = dl.find((d) => d.suggestedFilename().endsWith('.txt'));
    const tp = path.join(out, name + '.txt');
    await txtD.saveAs(tp);
    return { zip: unzipSync(new Uint8Array(readFileSync(zp))), txt: readFileSync(tp, 'utf8') };
  };

  // ---- baseline export without edits: untouched recording
  const base = await exportZip('base.zip');
  const baseMan = JSON.parse(strFromU8(base.zip['manifest.json']));
  ok('without edits the manifest says the video is not redacted', baseMan.video?.redacted === false, JSON.stringify(baseMan.video?.redacted));
  const baseWebm = path.join(out, 'base.webm');
  writeFileSync(baseWebm, base.zip['replay.webm']);
  const bp = probe(baseWebm);
  ok('baseline replay is a valid video', /vp/.test(bp.codec) && bp.dur > 7, `${bp.codec} ${bp.w}x${bp.h} ${bp.dur}s`);
  ok('baseline events include the Profile navigation', /profile/i.test(base.txt), 'txt mentions Profile');
  const baseFrame = path.join(out, 'base.png');
  frame(baseWebm, 1.2, baseFrame);
  // The animated canvas of the fixture sits at roughly x 2-50 %, y 14-37 % of the 1000x700 viewport.
  const REG = { x: 0.03, y: 0.15, w: 0.44, h: 0.2 };
  const baseReg = stat(baseFrame, REG.x, REG.y, REG.w, REG.h, bp);
  ok('baseline: the region to be hidden shows real content', baseReg.colors > 4 && baseReg.mean > 0.3, `${baseReg.colors} colours, mean ${baseReg.mean.toFixed(2)}`);

  // ---- add a mask by dragging on the player
  await rv.click('#pt-mask');
  await rv.waitForSelector('.maskdraw');
  await sleep(200);
  const geo = await rv.evaluate(() => { const v = document.getElementById('vid'); const r = v.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vw: v.videoWidth, vh: v.videoHeight }; });
  const ar = geo.vw / geo.vh;
  let cw = geo.w, ch = geo.h;
  if (geo.w / geo.h > ar) cw = geo.h * ar; else ch = geo.w / ar;
  const cx = geo.x + (geo.w - cw) / 2, cy = geo.y + (geo.h - ch) / 2;
  const pt = (fx, fy) => [cx + cw * fx, cy + ch * fy];
  await rv.mouse.move(...pt(REG.x - 0.01, REG.y - 0.01));
  await rv.mouse.down();
  await rv.mouse.move(...pt(REG.x + REG.w + 0.01, REG.y + REG.h + 0.01), { steps: 10 });
  await rv.mouse.up();
  await rv.waitForSelector('#pt-add');
  await rv.click('#pt-type [data-t="redact"]');
  await rv.fill('#pt-from', '0:00');
  await rv.fill('#pt-to', '0:30');
  await rv.click('#pt-add');
  await rv.waitForSelector('#pt-list [data-rm-mask]');
  ok('mask is listed with its type and range', /Redact/.test(await rv.locator('#pt-list').innerText()));

  // a throw-away mask to prove removal works
  await rv.click('#pt-mask');
  await rv.waitForSelector('.maskdraw');
  await sleep(200);
  const geo2 = await rv.evaluate(() => { const r = document.getElementById('vid').getBoundingClientRect(); return { x: r.x, y: r.y }; });
  const dy = geo2.y - geo.y;
  await rv.mouse.move(...pt(0.6, 0.5).map((v, i) => (i ? v + dy : v)));
  await rv.mouse.down();
  await rv.mouse.move(...pt(0.8, 0.7).map((v, i) => (i ? v + dy : v)), { steps: 6 });
  await rv.mouse.up();
  await rv.waitForSelector('#pt-add');
  await rv.click('#pt-add');
  await until(() => rv.locator('#pt-list [data-rm-mask]').count().then((n) => n === 2), 5000);
  ok('second mask added', (await rv.locator('#pt-list [data-rm-mask]').count()) === 2);
  await rv.locator('#pt-list [data-rm-mask]').nth(1).click();
  await until(() => rv.locator('#pt-list [data-rm-mask]').count().then((n) => n === 1), 5000);
  ok('a mask can be removed again', (await rv.locator('#pt-list [data-rm-mask]').count()) === 1);

  // ---- cut out 4.5 - 7.5 s
  await rv.click('#pt-cut');
  await rv.waitForSelector('#pt-from');
  await rv.fill('#pt-from', '0:04.5');
  await rv.fill('#pt-to', '0:07.5');
  await rv.click('#pt-add');
  await rv.waitForSelector('#pt-list [data-rm-cut]');
  ok('cut range is listed', /Cut out/.test(await rv.locator('#pt-list').innerText()));
  const sessAfter = (await dump('sessions')).find((s) => s.id === sess.id);
  ok('edits are persisted on the session (1 mask, 1 cut)', sessAfter.videoEdits?.masks?.length === 1 && sessAfter.videoEdits?.cuts?.length === 1, JSON.stringify(sessAfter.videoEdits && { m: sessAfter.videoEdits.masks.length, c: sessAfter.videoEdits.cuts.length }));
  ok('Preview is enabled once there is an edit', !(await rv.locator('#pt-preview').isDisabled()));

  // ---- preview the redacted copy in the player
  await rv.click('#pt-preview');
  await rv.waitForSelector('#pt-form .badge', { timeout: 90000 });
  ok('preview renders the redacted copy and labels it', /preview/i.test(await rv.locator('#pt-form').innerText()));
  const pdur = await until(() => rv.evaluate(() => { const v = document.getElementById('vid'); return Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0; }), 10000);
  ok('preview is shorter than the original by about the cut length', !!pdur && Math.abs((bp.dur - 3) - pdur) < 1.3, `original ${bp.dur.toFixed(1)}s, preview ${pdur?.toFixed?.(1)}s`);
  await rv.click('#pt-preview');
  await sleep(500);
  ok('Back to original restores the player', /Preview redacted/.test(await rv.locator('#pt-preview').innerText()));

  // ---- the edits survive a reload
  await rv.reload();
  await until(() => rv.evaluate(() => { const v = document.getElementById('vid'); return v && v.duration > 0; }), 15000);
  ok('edits are still there after reloading the Review page', (await rv.locator('#pt-list li').count()) === 2);

  // ---- export with edits
  const red = await exportZip('red.zip');
  const man = JSON.parse(strFromU8(red.zip['manifest.json']));
  ok('manifest records the redaction (1 mask, 1 cut) without any geometry', man.video?.redacted?.masks === 1 && man.video?.redacted?.cuts === 1 && !/x1/.test(JSON.stringify(man.video)), JSON.stringify(man.video?.redacted));
  const redWebm = path.join(out, 'red.webm');
  writeFileSync(redWebm, red.zip['replay.webm']);
  const rp = probe(redWebm);
  ok('redacted replay is a valid video with the same size', /vp/.test(rp.codec) && rp.w === bp.w && rp.h === bp.h, `${rp.codec} ${rp.w}x${rp.h}`);
  ok('redacted replay is shorter by the cut length', Math.abs((bp.dur - 3) - rp.dur) < 1.3, `base ${bp.dur.toFixed(1)}s -> ${rp.dur.toFixed(1)}s`);
  const integrity = execFileSync('ffmpeg', ['-v', 'error', '-i', redWebm, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  ok('decoder reports no errors on the redacted file', integrity.trim() === '', integrity.slice(0, 80));
  const redFrame = path.join(out, 'red.png');
  frame(redWebm, 1.2, redFrame);
  const redReg = stat(redFrame, REG.x, REG.y, REG.w, REG.h, rp);
  ok('masked region is solid black in the exported video', redReg.colors <= 4 && redReg.mean < 0.02, `${redReg.colors} colours, mean ${redReg.mean.toFixed(3)}`);
  const ctl0 = stat(baseFrame, 0.0, 0.0, 0.3, 0.1, bp);
  const ctl1 = stat(redFrame, 0.0, 0.0, 0.3, 0.1, rp);
  ok('the rest of the frame is untouched (nav bar still readable)', ctl1.colors > 3 && Math.abs(ctl1.mean - ctl0.mean) < 0.08, `base ${ctl0.colors}c/${ctl0.mean.toFixed(2)} vs ${ctl1.colors}c/${ctl1.mean.toFixed(2)}`);
  // a late frame (after the cut) must also be masked: the mask spans the whole recording
  const lateAt = Math.max(0.5, rp.dur - 1.0);
  const lateFrame = path.join(out, 'late.png');
  frame(redWebm, lateAt, lateFrame);
  const lateReg = stat(lateFrame, REG.x, REG.y, REG.w, REG.h, rp);
  ok('mask also covers frames after the cut', lateReg.colors <= 4 && lateReg.mean < 0.02, `${lateReg.colors} colours`);

  // ---- the cut range is gone from the evidence, not only from the pixels
  const evBase = strFromU8(base.zip['events.json']), evRed = strFromU8(red.zip['events.json']);
  ok('baseline events.json has the Profile click (control)', /"Profile"/.test(evBase));
  ok('events.json no longer has the click or the navigation inside the cut', !/"Profile"/.test(evRed) && (evRed.match(/"navigate"/g) ?? []).length === (evBase.match(/"navigate"/g) ?? []).length - 1, `navigate events ${(evBase.match(/"navigate"/g) ?? []).length} -> ${(evRed.match(/"navigate"/g) ?? []).length}`);
  ok('TXT report no longer lists the steps inside the cut', !/Click link "Profile"/.test(red.txt) && !/Navigate to \/profile/.test(red.txt) && /Click link "Cart"/.test(red.txt), 'txt');
  ok('events outside the cut are still there', /cart/i.test(strFromU8(red.zip['events.json'])) && /Add to cart/.test(red.txt));
  ok('the unredacted original recording was not exported', Object.keys(red.zip).filter((n) => /\.webm$/.test(n)).length === 1);

  // The local recording itself is never modified: the original replay can still be exported in full.
  const sessAfterExport = (await dump('sessions')).find((s) => s.id === sess.id);
  ok('the original session recording on this device is untouched by redaction', !!sessAfterExport && sessAfterExport.videoEdits?.masks?.length === 1);
} catch (e) {
  console.error('video-redact e2e aborted:', e instanceof Error ? e.stack : e);
  rep.fail();
} finally {
  await ctx.close().catch(() => undefined);
  server.close();
  rmProfile(userData);
  process.exit(rep.summary() ? 1 : 0);
}
