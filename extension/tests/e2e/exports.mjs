// Export / Evidence Package checks (B0.9, B0.10): runs a short capture, then exports every format from the real Review page.
import { launch, keyInfo, newReporter, rmProfile, sleep, startSite, tmpProfile } from './lib.mjs';
import { unzipSync, strFromU8 } from 'fflate';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PORT = 4175;
const server = await startSite(PORT);
const rep = newReporter();
const ok = rep.ok;
const userData = tmpProfile();
const { ctx, rd, state, setSettings, dump, until, activeTabId } = await launch(userData);
const out = mkdtempSync(path.join(tmpdir(), 'rd-exp-'));

try {
  await setSettings({ replaySec: 30, tailSec: 0, preSessionSec: 30, openReviewAfterSave: false, fps: 10, bitrateKbps: 1000 });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`);
  await page.bringToFront();
  await rd((id) => self.__rd.armTab(id), await activeTabId());
  ok('armed', (await state()).mode === 'armed');
  await sleep(2500);
  await rd(() => self.__rd.startRepro());
  await page.click('#add');
  await page.click('#nav-profile');
  await page.fill('#pw', 'SHOULD-NEVER-APPEAR');
  await rd(() => self.__rd.marker('Extra button'));
  await sleep(3000);
  await rd(() => self.__rd.finishRepro());
  const sess = (await dump('sessions')).find((s) => s.kind === 'repro');
  await sleep(1500); // let the async marker screenshot land
  const rv = await ctx.newPage();
  await rv.goto(`chrome-extension://${keyInfo.id}/review.html?session=${sess.id}`);
  await until(() => rv.evaluate(() => { const v = document.getElementById('vid'); return v && v.duration > 0; }), 15000);
  await rv.fill('#f-title', 'Checkout button missing <script>alert(1)</script>');
  await rv.fill('#f-actual', 'Actual: button is not shown');
  await rv.fill('#f-exp', 'Expected: button is shown');
  await rv.locator('#f-exp').blur();
  for (const f of ['html', 'txt', 'md', 'docx', 'xlsx', 'zip']) await rv.check(`[data-fmt="${f}"]`);
  const downloads = [];
  rv.on('download', (d) => downloads.push(d));
  await rv.click('#export');
  await until(async () => downloads.length >= 6, 25000);
  ok('one export action generated all 6 selected formats', downloads.length === 6, `downloads=${downloads.map((d) => d.suggestedFilename()).join(', ')}`);
  const files = {};
  for (const d of downloads) {
    const p = path.join(out, d.suggestedFilename());
    await d.saveAs(p);
    files[path.extname(p).slice(1)] = p;
  }
  const status = await rv.locator('#exstatus').innerText();
  ok('per-format status reports no failures', !/FAILED/.test(status), status.replace(/\n/g, ' | '));

  const zip = unzipSync(new Uint8Array(readFileSync(files.zip)));
  const names = Object.keys(zip);
  ok('Evidence Package has report, replay, events, session, manifest and screenshots', ['report.html', 'report.txt', 'replay.webm', 'events.json', 'session.json', 'manifest.json'].every((n) => names.includes(n)) && names.some((n) => n.startsWith('screenshots/')), names.join(', '));
  const manifest = JSON.parse(strFromU8(zip['manifest.json']));
  ok('manifest has schema/product/browser/policy versions', manifest.schema_version === 1 && !!manifest.reprodesk_version && /Chrome/.test(manifest.browser) && manifest.capture_policy_version === '0.2.4');
  const bad = manifest.artifacts.filter((a) => createHash('sha256').update(zip[a.path]).digest('hex') !== a.sha256);
  ok('manifest SHA-256 hashes match every file', bad.length === 0 && manifest.artifacts.length >= 6);
  const webm = path.join(out, 'replay.webm');
  writeFileSync(webm, zip['replay.webm']);
  let probe = '';
  try { probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'default=nw=1', webm]).toString(); } catch (e) { probe = String(e); }
  const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', webm]).toString().trim().split(/\s+/);
  ok('baseline media policy: the video file has no audio track', streams.length === 1 && streams[0] === 'video', streams.join(','));
  const dur = Number(/duration=([\d.]+)/.exec(probe)?.[1] ?? 0);
  ok('replay.webm in the package is a valid video (ffprobe)', /codec_name=vp/.test(probe) && dur > 3, probe.replace(/\n/g, ' '));
  const everything = Object.values(zip).map((b) => Buffer.from(b).toString('latin1')).join('');
  ok('no typed password anywhere in the package', !/SHOULD-NEVER-APPEAR/.test(everything));
  const html = readFileSync(files.html, 'utf8');
  ok('HTML report escapes user text (no script injection)', !/<script>alert\(1\)/.test(html) && /&lt;script&gt;/.test(html));
  ok('standalone HTML embeds screenshots as data URIs', /data:image\/png;base64,/.test(html));
  const txt = readFileSync(files.txt, 'utf8');
  ok('TXT report has steps, expected/actual and marker', /Click button "Add to cart"/.test(txt) && /Expected: button is shown/.test(txt) && /Extra button/.test(txt));
  ok('TXT explains it cannot embed screenshots (no silent drop)', /TXT cannot embed images/.test(txt));
  const docx = unzipSync(new Uint8Array(readFileSync(files.docx)));
  ok('DOCX is a valid package with an embedded screenshot', !!docx['word/document.xml'] && Object.keys(docx).some((n) => n.startsWith('word/media/')));
  const xlsx = unzipSync(new Uint8Array(readFileSync(files.xlsx)));
  ok('XLSX has Report/Steps/Timeline sheets', ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml'].every((n) => !!xlsx[n]));
  // Real consumers: LibreOffice must open both Office files.
  try {
    execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', out, files.docx], { stdio: 'ignore', timeout: 90000 });
    execFileSync('soffice', ['--headless', '--convert-to', 'csv', '--outdir', out, files.xlsx], { stdio: 'ignore', timeout: 90000 });
    const csv = readFileSync(files.xlsx.replace(/\.xlsx$/, '.csv'), 'utf8');
    ok('LibreOffice opens the DOCX and the XLSX', /Title/.test(csv) && /Expected: button is shown/.test(csv));
  } catch (e) {
    console.log('INFO  soffice not available for office-format round trip:', String(e).slice(0, 80));
  }
} catch (e) {
  console.error('exports e2e aborted:', e instanceof Error ? e.stack : e);
  rep.fail();
} finally {
  await ctx.close().catch(() => undefined);
  server.close();
  rmProfile(userData);
  process.exit(rep.summary() ? 1 : 0);
}
