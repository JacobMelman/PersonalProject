// Demo film: a paced, scripted run of the Northwind Gear scenario in real headed Chromium (Xvfb), recorded at 30 fps,
// with an eased mouse cursor, click ripples, human-speed typing and English caption cues captured at record time.
// Output (docs/demo/): reprodesk-demo.mp4 (clean), reprodesk-demo-subtitles.mp4 (captions in a bar under the picture), reprodesk-demo.en.srt
//   node scripts/film.mjs            (needs Xvfb, openbox, xdotool, ffmpeg with libass, ImageMagick, Pillow; see README)
import { startDisplay, launchChrome, tmpProfile, rmProfile, sleep, xdo, findPage, browserCdp, locateToolbarIcon, shot, keyInfo, DISPLAY } from '../tests/real/lib.mjs';
import { makeProbe } from '../tests/real/probe.mjs';
import { startDemoSite } from './demo-site.mjs';
import path from 'node:path';
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/demo');
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.RD_PORT ?? 9333), SITE = Number(process.env.RD_SITE ?? 5173);
const W = 1500, H = 940, FPS = 30, BAR = 100;
const work = path.join(out, '.film');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const dl = path.join(work, 'dl');
mkdirSync(dl, { recursive: true });

// ------------------------------------------------------------------ pointer, typing, ripples
let cur = { x: 760, y: 520 };
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
async function glide(x, y, ms = 700) {
  const steps = Math.max(10, Math.round(ms / 20));
  const from = { ...cur };
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    xdo('mousemove', String(Math.round(from.x + (x - from.x) * t)), String(Math.round(from.y + (y - from.y) * t)));
    await sleep(ms / steps);
  }
  cur = { x, y };
}
const press = () => xdo('mousedown', '1');
const release = () => xdo('mouseup', '1');
async function click(x, y, ms) { await glide(x, y, ms); await sleep(160); xdo('click', '1'); await sleep(260); }
async function drag(a, b, ms = 800) { await glide(a.x, a.y, 600); await sleep(150); press(); await sleep(120); await glide(b.x, b.y, ms); await sleep(150); release(); await sleep(300); }
const typeText = async (text, delay = 80) => { xdo('type', '--delay', String(delay), text); await sleep(250); };
const selectAll = () => xdo('key', 'ctrl+a');

const RIPPLE = `(() => { if (window.__rip) return; window.__rip = 1;
  const st = document.createElement('style');
  st.textContent = '@keyframes rdrip{from{transform:translate(-50%,-50%) scale(.3);opacity:.9}to{transform:translate(-50%,-50%) scale(1.8);opacity:0}}.rdrip{position:fixed;z-index:2147483647;width:44px;height:44px;border-radius:50%;border:3px solid #ff6b35;background:rgba(255,107,53,.22);pointer-events:none;animation:rdrip .6s ease-out forwards}';
  document.documentElement.appendChild(st);
  addEventListener('pointerdown', (e) => { const d = document.createElement('div'); d.className = 'rdrip'; d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; document.documentElement.appendChild(d); setTimeout(() => d.remove(), 750); }, true);
})()`;
const ripple = (page) => page.eval(RIPPLE).catch(() => undefined);

/** screen = client + offset, measured with a real mouse move (works for tab pages and for the side panel alike). */
async function calibrate(page, at) {
  await page.eval(`window.__mm = null; addEventListener('mousemove', (e) => { window.__mm = [e.clientX, e.clientY]; }, true)`);
  xdo('mousemove', String(at.x - 6), String(at.y - 6)); await sleep(90);
  xdo('mousemove', String(at.x), String(at.y)); await sleep(180);
  const m = await page.eval(`window.__mm`);
  if (!m) throw new Error('calibration failed');
  cur = { ...at };
  return { dx: at.x - m[0], dy: at.y - m[1] };
}
const rectOf = (page, sel, scroll) => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; ${scroll ? `e.scrollIntoView({ block: 'nearest', behavior: 'instant' });` : ''} const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
async function settleScroll(page) {
  let last = -1;
  for (let i = 0; i < 30; i++) { const y = await page.eval(`Math.round(window.scrollY)`); if (y === last) return; last = y; await sleep(120); }
}
async function smoothTo(page, sel, block = 'center') {
  await page.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: ${JSON.stringify(block)}, behavior: 'smooth' })`);
  await sleep(500); await settleScroll(page); await sleep(250);
}
async function clickEl(page, off, sel, { ms = 700, scroll = true, dx = 0.5, dy = 0.5 } = {}) {
  const r = await rectOf(page, sel, scroll);
  if (!r) throw new Error('element not found: ' + sel);
  await click(Math.round(off.dx + r.x + r.w * dx), Math.round(off.dy + r.y + r.h * dy), ms);
}
const pointAt = (off, r, fx, fy) => ({ x: Math.round(off.dx + r.x + r.w * fx), y: Math.round(off.dy + r.y + r.h * fy) });

// ------------------------------------------------------------------ captions
let recStartWall = 0;
const cues = [];
const vt = () => (Date.now() - recStartWall) / 1000;
const say = (text, hold) => { const s = vt(); cues.push({ s, e: s + (hold ?? Math.min(7, Math.max(3, text.length / 13))), text }); };
const beat = (ms) => sleep(ms);
const readHold = (text) => Math.min(8, Math.max(3, 1.6 + text.length / 16));
/** A caption that stays up for the whole scene (at least long enough to read), while the actions run. */
async function scene(text, fn, minHold) {
  const cue = { s: vt(), e: 0, text };
  cues.push(cue);
  const t0 = Date.now();
  if (fn) await fn();
  const rest = (minHold ?? readHold(text)) * 1000 - (Date.now() - t0);
  if (rest > 0) await sleep(rest);
  cue.e = vt();
}

// ------------------------------------------------------------------ scenario
const site = await startDemoSite(SITE);
const disp = await startDisplay('1600x1000x24');
const ud = tmpProfile();
const chrome = await launchChrome({ userData: ud, port: PORT, startUrl: `http://localhost:${SITE}/`, width: W, height: H });
let rec = null;
let browser = null;
try {
  await sleep(3500);
  const probe = await makeProbe(PORT);
  await probe.setSettings({ replaySec: 90, tailSec: 3, preSessionSec: 30, fps: 15, bitrateKbps: 2500, afkMinutes: 0, openReviewAfterSave: false, environment: 'QA · staging', markerScreenshot: true });
  browser = await browserCdp(PORT);
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: false });
  const page = await findPage(PORT, `http://localhost:${SITE}/`);
  await ripple(page);
  const tabOff = await calibrate(page, { x: 420, y: 420 });
  await sleep(500);

  // ---- start recording (timing anchor comes from ffmpeg's own progress clock)
  const raw = path.join(work, 'raw.mp4');
  rec = spawn('ffmpeg', ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-f', 'x11grab', '-framerate', String(FPS), '-video_size', `${W}x${H}`, '-draw_mouse', '1', '-i', `${DISPLAY}.0+0,0`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', raw], { stdio: ['pipe', 'pipe', 'inherit'] });
  rec.stdout.on('data', (d) => { for (const m of String(d).matchAll(/out_time_us=(\d+)/g)) recStartWall = Date.now() - Number(m[1]) / 1000; });
  for (let i = 0; i < 40 && !recStartWall; i++) await sleep(100);
  if (!recStartWall) throw new Error('screen recorder did not start');
  await sleep(600);

  // ---- 1. intro
  await scene('ReproDesk: capture a bug once, give developers the evidence.');
  await scene('Demo app: Northwind Gear, a web shop with two deliberate bugs.');

  // ---- 2. arm
  const iconX = locateToolbarIcon();
  if (iconX < 0) throw new Error('toolbar icon not found');
  let panel, panelOff;
  await scene('One click on the toolbar icon arms ReproDesk for this tab only. Chrome requires that explicit action, so nothing records silently.', async () => {
    await click(iconX, 63, 1100);
    await probe.until(async () => (await probe.state())?.mode === 'armed', 12000);
    panel = await findPage(PORT, 'chrome-extension://' + keyInfo.id + '/sidepanel.html');
    await ripple(panel);
    panelOff = await calibrate(panel, { x: 1420, y: 420 });
    await ripple(page);
  });
  await scene('Armed: a rolling buffer keeps only the last 90 seconds, locally. No keystrokes are collected and only this tab is recorded.', async () => {
    await glide(panelOff.dx + 190, panelOff.dy + 215, 900);
  });

  // ---- 3. normal testing
  await scene('Test as usual: ReproDesk quietly keeps the latest moments in its buffer.', async () => {
    await clickEl(page, tabOff, '[data-add="backpack"]'); await beat(800);
    await clickEl(page, tabOff, '[data-add="tent"]'); await beat(800);
    await clickEl(page, tabOff, '[data-add="lamp"]'); await beat(1200);
    await glide(panelOff.dx + 190, panelOff.dy + 330, 800);
    await beat(4500);
  });

  // ---- 4. instant replay
  await scene('Something looked wrong? Save last replay (Alt+Shift+R) keeps what just happened, so there is no need to reproduce it.', async () => {
    await clickEl(panel, panelOff, '[data-c="saveReplay"]', { ms: 900 });
    await beat(3200);
  });

  // ---- 5. repro session
  await scene('For a known bug, start a Repro Session: the whole path is recorded, plus 30 seconds of context from before the start.', async () => {
    await clickEl(page, tabOff, '#nav-cart', { ms: 800 });
    await beat(1200);
    await clickEl(panel, panelOff, '[data-c="startRepro"]', { ms: 900 });
    await beat(1500);
  });

  // ---- 6. bug 1
  await scene('Bug 1: the promo code SUMMER20 shows a discount, but the total does not change.', async () => {
    await clickEl(page, tabOff, '#promo'); await typeText('summer20', 120); await beat(500);
    await clickEl(page, tabOff, '#apply'); await beat(2200);
  });
  await scene('Add a marker to flag the moment. A screenshot is taken automatically.', async () => {
    await clickEl(panel, panelOff, '#markerLabel'); await typeText('Promo discount not applied to total', 55);
    await clickEl(panel, panelOff, '[data-c="marker"]'); await beat(1800);
  });

  // ---- 7. bug 2
  await scene('Fill in the checkout form. Typed text is never stored as events; the pixels can be hidden later, before sharing.', async () => {
    await clickEl(page, tabOff, '#checkout-btn', { ms: 800 }); await beat(1500);
    await clickEl(page, tabOff, '#name'); await typeText('Alex Morgan', 90);
    await clickEl(page, tabOff, '#email'); await typeText('alex@example.com', 70);
    await clickEl(page, tabOff, '#card'); await typeText('4242424242424242', 110);
    await clickEl(page, tabOff, '#exp'); await typeText('1228', 110);
    await clickEl(page, tabOff, '#cvv'); await typeText('123', 110); await beat(500);
  });
  await scene('Bug 2: Place order fails with error E-4021.', async () => {
    await clickEl(page, tabOff, '#place'); await beat(2300);
    await clickEl(panel, panelOff, '#markerLabel'); await typeText('Order fails with E-4021', 55);
    await clickEl(panel, panelOff, '[data-c="marker"]'); await beat(1500);
  });
  const boxes = await page.eval(`(() => { const n = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x / innerWidth, r.y / innerHeight, (r.x + r.width) / innerWidth, (r.y + r.height) / innerHeight]; }; return { card: n('#card'), err: n('#error .err') }; })()`);

  // ---- 8. privacy pause
  let blank = null;
  await scene('Look at another tab and recording pauses by itself. Nothing from other tabs is ever stored.', async () => {
    blank = (await browser.send('Target.createTarget', { url: 'about:blank' })).targetId;
    await beat(3800);
  });
  await scene('Back on the approved tab, capture resumes.', async () => {
    await browser.send('Target.closeTarget', { targetId: blank });
    const fix = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith(`http://localhost:${SITE}/`));
    if (fix) await browser.send('Target.activateTarget', { targetId: fix.id });
    await beat(2000);
  });

  // ---- 9. finish and review
  let rv = null;
  await probe.setSettings({ openReviewAfterSave: true }); // the report should open by itself now, but not after the quick replay above
  await scene('Finish & review stops the recording and opens the report.', async () => {
    await clickEl(panel, panelOff, '[data-c="finishRepro"]', { ms: 900 });
    for (let i = 0; i < 40 && !rv; i++) { await sleep(500); rv = await findPage(PORT, `chrome-extension://${keyInfo.id}/review.html?session=`); }
    if (!rv) throw new Error('Review page did not open');
    await sleep(1200);
    await click(W - 28, 101, 900); // close the side panel: the report gets the whole window
    await sleep(900);
    await ripple(rv);
  });
  await scene('Review: the video, a live timeline and steps drafted from what really happened. No AI guesses.', async () => {
    await rv.eval(`(() => { const v = document.getElementById('vid'); v.muted = true; v.currentTime = 4; return v.play(); })()`).catch(() => undefined);
    await glide(tabOff.dx + 760, tabOff.dy + 520, 900);
    await beat(2800);
  });
  await scene('Click any row of the timeline to jump to that moment in the video.', async () => {
    const row = await rv.eval(`(() => { const rows = [...document.querySelectorAll('#tl .tl')]; const i = rows.findIndex((r) => /Place order/i.test(r.textContent)); return i < 0 ? 8 : i; })()`);
    await rv.eval(`document.querySelector('#tl [data-i="${row}"]').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await sleep(400);
    await clickEl(rv, tabOff, `#tl [data-i="${row}"]`, { ms: 900 });
    await beat(1800);
  });

  // ---- 10. screenshot editor
  await smoothTo(rv, '.gallery', 'center');
  await scene('Hide sensitive data before sharing: open a screenshot, blur the card number and box the error.', async () => {
    await clickEl(rv, tabOff, '[data-edit="1"]', { ms: 900 });
    await sleep(1400);
    await ripple(rv);
    const c = await rectOf(rv, '#ed-canvas');
    const pad = 0.012;
    await clickEl(rv, tabOff, '[data-tool="blur"]');
    await drag(pointAt(tabOff, c, boxes.card[0] - pad, boxes.card[1] - pad * 1.4), pointAt(tabOff, c, boxes.card[2] + pad, boxes.card[3] + pad * 1.4));
    await beat(700);
    await clickEl(rv, tabOff, '[data-tool="rect"]');
    await drag(pointAt(tabOff, c, boxes.err[0] - pad, boxes.err[1] - pad), pointAt(tabOff, c, boxes.err[2] + pad, boxes.err[3] + pad));
    await beat(900);
  });
  await scene('The original screenshot is never modified. Only the exported copy carries the blur.', async () => {
    await clickEl(rv, tabOff, '#ed-save', { ms: 900 });
    await beat(1500);
  });

  // ---- 11. video privacy tools
  await smoothTo(rv, '.player', 'center');
  await scene('Do the same for video: mask the card field. The preview shows exactly what will be exported.', async () => {
    await clickEl(rv, tabOff, '#pt-mask', { ms: 900 });
    await sleep(500);
    const vr = await rv.eval(`(() => { const v = document.getElementById('vid'); const r = v.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vw: v.videoWidth, vh: v.videoHeight }; })()`);
    const ar = vr.vw / vr.vh; let cw = vr.w, ch = vr.h; if (vr.w / vr.h > ar) cw = vr.h * ar; else ch = vr.w / ar;
    const vc = { x: vr.x + (vr.w - cw) / 2, y: vr.y + (vr.h - ch) / 2, w: cw, h: ch };
    const pad = 0.012;
    await drag(pointAt(tabOff, vc, boxes.card[0] - pad / 2, boxes.card[1] - pad), pointAt(tabOff, vc, boxes.card[2] + pad / 2, boxes.card[3] + pad), 900);
    await beat(700);
    await clickEl(rv, tabOff, '#pt-from'); selectAll(); await typeText('0:00', 100);
    await clickEl(rv, tabOff, '#pt-to'); selectAll(); await typeText('59:00', 100);
    await clickEl(rv, tabOff, '#pt-add', { ms: 800 }); await beat(900);
    await clickEl(rv, tabOff, '#pt-preview', { ms: 800 });
    for (let i = 0; i < 120; i++) { if (await rv.eval(`!!document.querySelector('#pt-form .badge')`)) break; await sleep(500); }
    await sleep(600);
    await rv.eval(`(() => { const v = document.getElementById('vid'); v.pause(); v.currentTime = Math.max(0, v.duration - 5.5); })()`);
    await beat(3000);
    await clickEl(rv, tabOff, '#pt-preview', { ms: 700 }); await beat(600);
  });

  // ---- 12. report and export
  await smoothTo(rv, '#f-actual', 'center');
  await scene('Describe what happened and what you expected. The expected result is always written by you.', async () => {
    await clickEl(rv, tabOff, '#f-actual'); await typeText('Promo SUMMER20 shows a discount but the total is unchanged; Place order fails with E-4021.', 35);
    await clickEl(rv, tabOff, '#f-exp'); await typeText('The total includes the discount and the order is placed.', 35);
    await beat(500);
  });
  await smoothTo(rv, '#export', 'center');
  await scene('One click exports an Evidence Package, an HTML report and a Word report.', async () => {
    await clickEl(rv, tabOff, '.fmt:has([data-fmt="docx"])', { ms: 800 });
    await beat(400);
    await clickEl(rv, tabOff, '#export', { ms: 800 });
    for (let i = 0; i < 90; i++) { if (readdirSync(dl).filter((f) => !f.endsWith('.crdownload')).length >= 3) break; await sleep(500); }
    await beat(1500);
  });

  // ---- 13. exported report
  const htmlFile = readdirSync(dl).find((f) => f.endsWith('.html'));
  if (htmlFile) {
    await scene('The HTML report is self-contained, with the blurred screenshots, so developers can open it anywhere.', async () => {
      await browser.send('Target.createTarget', { url: 'file://' + path.join(dl, htmlFile) });
      await sleep(2500);
      const rp = await findPage(PORT, 'file://');
      await rp?.eval(`window.scrollTo({ top: 640, behavior: 'smooth' })`);
      await beat(3200);
      await rp?.eval(`window.scrollTo({ top: 1500, behavior: 'smooth' })`);
      await beat(2800);
    });
  }

  // ---- 14. closing
  await scene('Everything stays on this device until you export it. Administrators can lock settings and restrict sites with standard browser policies.', async () => {
    await browser.send('Target.createTarget', { url: `chrome-extension://${keyInfo.id}/review.html` });
    await sleep(2500);
  });
  await scene('ReproDesk: evidence instead of retelling.', null, 3.5);
  await sleep(600);
} catch (e) {
  console.error('film aborted:', e instanceof Error ? e.stack : e);
  process.exitCode = 1;
} finally {
  if (rec) { rec.stdin.write('q'); await new Promise((r) => { rec.on('exit', r); setTimeout(r, 8000); }); }
  browser?.close();
  await chrome.close(); disp.stop(); site.close(); rmProfile(ud);
}
if (process.exitCode) process.exit(process.exitCode);

// ------------------------------------------------------------------ post-production
const raw = path.join(work, 'raw.mp4');
if (!existsSync(raw)) throw new Error('no recording');
const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', raw]).toString());
cues.forEach((c, i) => { const next = cues[i + 1]; c.e = Math.min(c.e, next ? next.s - 0.08 : dur - 0.2); });
const ts = (t, srt) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; const sec = srt ? s.toFixed(3).replace('.', ',').padStart(6, '0') : s.toFixed(2).padStart(5, '0'); return srt ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}` : `${h}:${String(m).padStart(2, '0')}:${sec}`; };
const wrap = (text, n = 78) => { const lines = []; let line = ''; for (const w of text.split(' ')) { if ((line + ' ' + w).trim().length > n) { lines.push(line); line = w; } else line = (line + ' ' + w).trim(); } if (line) lines.push(line); return lines; };
writeFileSync(path.join(out, 'reprodesk-demo.en.srt'), cues.map((c, i) => `${i + 1}\n${ts(c.s, true)} --> ${ts(c.e, true)}\n${wrap(c.text).join('\n')}\n`).join('\n'));
const TH = H + BAR;
const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${TH}\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Cap,Inter,30,&H00FFFFFF,&H00FFFFFF,&H002B1A0E,&H002B1A0E,0,0,0,0,100,100,0,0,1,0,0,2,60,60,22,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${cues.map((c) => `Dialogue: 0,${ts(c.s, false)},${ts(c.e, false)},Cap,,0,0,0,,${wrap(c.text).join('\\N')}`).join('\n')}\n`;
const assFile = path.join(work, 'captions.ass');
writeFileSync(assFile, ass);
const fade = `fade=t=in:st=0:d=0.5,fade=t=out:st=${(dur - 0.7).toFixed(2)}:d=0.7`;
const enc = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an'];
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-vf', fade, ...enc, path.join(out, 'reprodesk-demo.mp4')]);
const fontDir = '/usr/share/fonts/opentype/inter';
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-vf', `pad=${W}:${TH}:0:0:color=0x0E1A2B,subtitles=${assFile}:fontsdir=${fontDir},${fade}`, ...enc, path.join(out, 'reprodesk-demo-subtitles.mp4')]);
console.log(`film done: ${dur.toFixed(1)} s, ${cues.length} captions -> docs/demo/reprodesk-demo.mp4, reprodesk-demo-subtitles.mp4, reprodesk-demo.en.srt`);
rmSync(work, { recursive: true, force: true });
