// Click highlights: where the user clicked is shown as a ring over the replay in Review and in the exported video, at the
// right place and time, also on a page that does not change (the re-encoder adds the frames the ring needs), and not at all
// when "Highlight clicks" is off. The stored recording itself is never touched.
import { keyInfo, launch, newReporter, rmProfile, sleep, startSite, tmpProfile } from './lib.mjs';
import { unzipSync, strFromU8 } from 'fflate';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PORT = 4187;
const server = await startSite(PORT);
const rep = newReporter();
const ok = rep.ok;
const userData = tmpProfile();
// No viewport emulation: an emulated viewport is taller than the window's real surface (the browser's own bars take 138 px),
// and the capture then crops or letterboxes the page unpredictably, which a real window never does. Without emulation the
// automation info bar shifts Playwright's mouse by its height, so the click is dispatched on the target itself (the content
// script treats it like any click). The mapping through letterbox bars is covered by the unit tests.
const { ctx, rd, setSettings, dump, until, activeTabId } = await launch(userData, { viewport: null });
const out = mkdtempSync(path.join(tmpdir(), 'rd-clicks-'));

// Centroid of the pixels matching `test` in a frame, via ImageMagick's text dump (small frames, fine for a test).
const centroid = (png, test) => {
  const txt = execFileSync('convert', [png, '-depth', '8', 'txt:-'], { maxBuffer: 64 * 1024 * 1024 }).toString();
  let n = 0, sx = 0, sy = 0;
  for (const line of txt.split('\n')) {
    const m = /^(\d+),(\d+): \((\d+),(\d+),(\d+)/.exec(line);
    if (m && test(+m[3], +m[4], +m[5])) { n++; sx += +m[1]; sy += +m[2]; }
  }
  return n ? { n, x: sx / n, y: sy / n } : { n: 0 };
};
const isRed = (r, g, b) => r > 190 && g < 140 && b < 140 && r - g > 80;
const isTarget = (r, g, b) => b > 140 && b - r > 50 && b - g > 80; // blue (VP9 softens it): never confused with bars or the ring
const frameAt = (webm, t, name) => { const p = path.join(out, name); execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.max(0, t)), '-i', webm, '-frames:v', '1', p]); return p; };

try {
  await setSettings({ replaySec: 30, tailSec: 0, preSessionSec: 0, openReviewAfterSave: false, markerScreenshot: false, fps: 10, highlightClicks: true });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/popup.html`);
  await page.bringToFront();
  // a still, grey page with one small blue target: nothing on it changes when it is clicked
  await page.evaluate(() => {
    const bg = document.createElement('div');
    bg.style.cssText = 'position:fixed;inset:0;background:rgb(128,128,128);z-index:99998';
    const t = document.createElement('div');
    t.id = '__target';
    t.style.cssText = 'position:fixed;left:68%;top:38%;width:12px;height:12px;background:rgb(20,40,230);z-index:99999';
    document.body.append(bg, t);
  });
  await rd((id) => self.__rd.armTab(id), await activeTabId());
  await sleep(3500);
  // measured at the moment of the click: starting the capture can change the window's height (a sharing bar appears)
  const target = await page.evaluate(() => {
    const el = document.getElementById('__target');
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, clientX: x, clientY: y, button: 0 }));
    return { x, y, vw: innerWidth, vh: innerHeight };
  });
  await sleep(3500);
  await rd(() => self.__rd.saveReplay());
  const sess = await until(async () => (await dump('sessions')).find((s) => s.kind === 'instant' && s.status !== 'active'), 20000);
  const click = (await dump('events')).filter((e) => e.sessionId === sess.id && e.type === 'click').at(-1);
  ok('the click is stored with its position and the viewport size', !!click?.pos && click.vp?.w === target.vw && Math.abs(click.pos.x - target.x / target.vw) < 0.01 && Math.abs(click.pos.y - target.y / target.vh) < 0.01, JSON.stringify(click?.pos));

  const rv = await ctx.newPage();
  await rv.goto(`chrome-extension://${keyInfo.id}/review.html?session=${sess.id}`);
  await until(() => rv.evaluate(() => { const v = document.getElementById('vid'); return v && v.duration > 0; }), 20000);
  ok('Review offers "Highlight clicks", on by default', await rv.locator('#hlclicks').isChecked());

  // jump to the click with its timeline row, then look at the overlay a moment later
  const clickT = await rv.evaluate(() => {
    const row = [...document.querySelectorAll('#tl [data-i]')].filter((r) => /Click/.test(r.textContent ?? '')).at(-1);
    row?.click();
    return document.getElementById('vid').currentTime;
  });
  // where the ring belongs in the picture: the viewport fitted into the frame (Chrome adds bars when their shapes differ)
  const fw = await rv.evaluate(() => document.getElementById('vid').videoWidth), fh = await rv.evaluate(() => document.getElementById('vid').videoHeight);
  const s = Math.min(fw / click.vp.w, fh / click.vp.h);
  console.log(`video ${fw}x${fh}, viewport ${click.vp.w}x${click.vp.h}`);
  const want = { x: ((fw - click.vp.w * s) / 2 + click.pos.x * click.vp.w * s) / fw, y: ((fh - click.vp.h * s) / 2 + click.pos.y * click.vp.h * s) / fh };
  const overlayAt = (t) => rv.evaluate(async ({ t, x, y }) => {
    const v = document.getElementById('vid');
    v.pause();
    v.currentTime = t;
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    await new Promise((r) => setTimeout(r, 100));
    const cv = document.getElementById('vclicks');
    const px = cv.getContext('2d').getImageData(Math.round(x * cv.width), Math.round(y * cv.height), 1, 1).data;
    return px[3];
  }, { t, x: want.x, y: want.y });
  const during = await overlayAt(clickT + 0.2);
  const after = await overlayAt(clickT + 1.5);
  ok('the Review player shows a ring at the click position right after the click, and it is gone a second later', during > 40 && after === 0, `alpha at +0.2 s ${during}, at +1.5 s ${after}`);

  const dl = [];
  rv.on('download', (d) => dl.push(d));
  const exportZip = async (name) => {
    dl.length = 0;
    await rv.evaluate(() => document.querySelectorAll('[data-fmt]').forEach((c) => (c.checked = c.dataset.fmt === 'zip')));
    await rv.click('#export');
    await until(async () => dl.length >= 1, 90000);
    const zp = path.join(out, name);
    await dl[0].saveAs(zp);
    const zip = unzipSync(new Uint8Array(readFileSync(zp)));
    const webm = path.join(out, name + '.webm');
    writeFileSync(webm, zip['replay.webm']);
    return { webm, manifest: JSON.parse(strFromU8(zip['manifest.json'])) };
  };

  const on = await exportZip('on.zip');
  ok('the manifest says the exported video shows click highlights', on.manifest.video?.click_highlights === true);
  // a still page has few frames and ffmpeg returns the first frame at or after the seek point: take the very first one
  const tgt = centroid(frameAt(on.webm, 0, 'before.png'), isTarget);
  const ring = centroid(frameAt(on.webm, clickT + 0.25, 'during.png'), isRed);
  const gone = centroid(frameAt(on.webm, clickT + 1.6, 'after.png'), isRed);
  const dist = tgt.n && ring.n ? Math.hypot(tgt.x - ring.x, tgt.y - ring.y) : Infinity;
  ok('the exported video has the ring centred on what was clicked', ring.n > 30 && dist < 12, `ring px ${ring.n}, target at ${tgt.x?.toFixed(0)},${tgt.y?.toFixed(0)}, ring at ${ring.x?.toFixed(0)},${ring.y?.toFixed(0)}, distance ${dist.toFixed(1)}`);
  ok('on a still page the ring still disappears (frames are added for it)', gone.n === 0, `red px a second later: ${gone.n}`);

  await rv.click('#hlclicks');
  ok('turning it off is remembered', (await rd(async () => (await chrome.storage.local.get('settings')).settings.highlightClicks)) === false);
  const off = await exportZip('off.zip');
  const offRing = centroid(frameAt(off.webm, clickT + 0.25, 'off-during.png'), isRed);
  ok('with "Highlight clicks" off the export is the untouched recording', off.manifest.video?.click_highlights === false && offRing.n === 0, `red px ${offRing.n}`);
} catch (e) {
  console.error('click-marks e2e aborted:', e instanceof Error ? e.stack : e);
  rep.fail();
} finally {
  await ctx.close().catch(() => undefined);
  server.close();
  rmProfile(userData);
  const failed = rep.summary();
  if (failed || process.env.KEEP_FRAMES) console.log('frames kept in', out); else rmSync(out, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
