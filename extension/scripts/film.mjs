// Demo film: a paced, scripted run of the Northwind Gear scenario in real headed Chromium (Xvfb), recorded at 30 fps,
// with an eased mouse cursor, click ripples, human-speed typing, an English voice-over and YouTube-style captions.
// The narration is synthesized first (offline neural TTS, Piper), so every scene lasts at least as long as its narration and
// every caption is timed to the exact phrase being spoken.
// Output (docs/demo/): reprodesk-demo.mp4 (voice-over, no captions), reprodesk-demo-subtitles.mp4 (voice-over + captions), reprodesk-demo.en.srt
//   node scripts/film.mjs     needs Xvfb, openbox, xdotool, ffmpeg with libass, ImageMagick, Pillow (see README); the first run also
//   creates a Python venv with piper-tts and fetches the CC0 voice "en_US joe medium" from npm into ~/.cache/reprodesk-film.
//   FILM_VOICE_MODEL=/path/voice.onnx (with voice.onnx.json next to it) uses any other Piper voice instead.
import { startDisplay, launchChrome, tmpProfile, rmProfile, sleep, xdo, findPage, browserCdp, locateToolbarIcon, shot, keyInfo, DISPLAY } from '../tests/real/lib.mjs';
import { makeProbe } from '../tests/real/probe.mjs';
import { startDemoSite } from './demo-site.mjs';
import path from 'node:path';
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/demo');
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.RD_PORT ?? 9333), SITE = Number(process.env.RD_SITE ?? 5173);
const W = 1500, H = 940, FPS = 30;
const here = path.dirname(fileURLToPath(import.meta.url));
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
const vt = () => (Date.now() - recStartWall) / 1000;
const beat = (ms) => sleep(ms);
const timeline = {};
/** One narrated scene: the voice starts with the scene, the scene lasts at least as long as its narration (+ a breath). */
async function scene(id, fn, extra = 0.6) {
  if (!VOICE[id]) throw new Error('no narration for scene ' + id);
  timeline[id] = vt();
  const t0 = Date.now();
  if (fn) await fn();
  const rest = (VOICE[id].duration + extra) * 1000 - (Date.now() - t0);
  if (rest > 0) await sleep(rest);
}


// ------------------------------------------------------------------ narration (spoken text -> caption text)
const C = (say, show = say) => ({ say, show });
const NARRATION = {
  intro: [C('This is Repro Desk.', 'This is ReproDesk.'), C('It captures a bug once, and gives developers the evidence.')],
  app: [C('Our demo app is Northwind Gear:'), C('a web shop with two deliberate bugs.')],
  arm: [C('One click on the toolbar icon arms Repro Desk for this tab only.', 'One click on the toolbar icon arms ReproDesk for this tab only.'), C('Chrome requires that explicit click, so nothing ever records silently.')],
  armed: [C('Now it is armed.'), C('A rolling buffer keeps only the last ninety seconds, on this computer.', 'A rolling buffer keeps only the last 90 seconds, on this computer.'), C('No keystrokes are collected, and only this tab is recorded.')],
  test: [C('Test as usual.'), C('Repro Desk quietly keeps the latest moments in its buffer.', 'ReproDesk quietly keeps the latest moments in its buffer.')],
  replay: [C('Something looked wrong?'), C('Save last replay keeps what just happened.'), C('The shortcut is Alt, Shift, R. There is no need to reproduce it.', 'Shortcut: Alt+Shift+R. No need to reproduce it.')],
  repro: [C('For a known bug, start a Repro Session.'), C('It records the whole path, plus thirty seconds of context from before the start.', 'It records the whole path, plus 30 seconds of context from before the start.')],
  bug1: [C('Bug one: the promo code summer twenty shows a discount,', 'Bug 1: the promo code SUMMER20 shows a discount,'), C('but the total does not change.')],
  marker: [C('Add a marker to flag this moment.'), C('A screenshot is taken automatically.')],
  checkout: [C('Now the checkout form.'), C('Typed text is never stored as events.'), C('The video does show pixels, though,'), C('so we will hide sensitive values before sharing.')],
  bug2: [C('Bug two: place order fails, with error E, forty twenty one.', 'Bug 2: Place order fails with error E-4021.')],
  pause: [C('If you look at another tab, recording pauses by itself.'), C('Nothing from other tabs is ever stored.')],
  resume: [C('Back on the approved tab, capture resumes.')],
  finish: [C('Finish and review stops the recording, and opens the report.', 'Finish & review stops the recording and opens the report.')],
  review: [C('Here is the report: the video, a live timeline,'), C('and steps drafted from what really happened. No A I guesses.', 'and steps drafted from what really happened. No AI guesses.')],
  timeline: [C('Click any row of the timeline to jump to that moment.')],
  editor: [C('Before sharing, hide sensitive data.'), C('Open a screenshot, blur the card number, and box the error.')],
  editorSave: [C('The original screenshot is never modified.'), C('Only the exported copy carries the blur.')],
  videoFind: [C('Now the video. First, jump to a moment where the card number is on screen.')],
  videoMask: [C('Drag a box over the card field.'), C('Blur it from the moment the number is typed until the error appears.')],
  videoMask2: [C('The error message pushes the form down,'), C('so a second mask covers the field until the end.')],
  videoPreview: [C('The preview shows exactly what will be exported.')],
  videoDone: [C('Now the card number is hidden in every frame where it appears.')],
  describe: [C('Describe what happened, and what you expected.'), C('The expected result is always written by you.')],
  export: [C('One click exports an evidence package, an H T M L report, and a Word document.', 'One click exports an Evidence Package, an HTML report and a Word document.')],
  html: [C('The H T M L report is self contained, with the blurred screenshots,', 'The HTML report is self-contained, with the blurred screenshots,'), C('so developers can open it anywhere.')],
  closing: [C('Everything stays on this device until you export it.'), C('Administrators can lock settings and restrict sites with standard browser policies.')],
  final: [C('Repro Desk: evidence instead of retelling.', 'ReproDesk: evidence instead of retelling.')],
};

function ensureVoice() {
  const cache = process.env.FILM_CACHE || path.join(os.homedir(), '.cache', 'reprodesk-film');
  mkdirSync(cache, { recursive: true });
  const venv = path.join(cache, 'venv');
  const py = path.join(venv, 'bin', 'python');
  if (!existsSync(py)) {
    execFileSync('python3', ['-m', 'venv', venv], { stdio: 'inherit' });
    execFileSync(path.join(venv, 'bin', 'pip'), ['install', '-q', 'piper-tts==1.8.0', 'numpy'], { stdio: 'inherit' });
  }
  if (process.env.FILM_VOICE_MODEL) return { py, model: process.env.FILM_VOICE_MODEL, config: process.env.FILM_VOICE_MODEL + '.json' };
  const vdir = path.join(cache, 'voice');
  const model = path.join(vdir, 'package', 'float.onnx');
  if (!existsSync(model)) {
    mkdirSync(vdir, { recursive: true });
    const tgz = execFileSync('npm', ['pack', 'vowel-lab-voices-float@0.1.0', '--silent'], { cwd: vdir }).toString().trim().split('\n').pop();
    execFileSync('tar', ['xzf', path.join(vdir, tgz), '-C', vdir]);
  }
  const config = model + '.json';
  if (!existsSync(config)) execFileSync(py, [path.join(here, 'narrate.py'), 'config', config]);
  return { py, model, config };
}

const voice = ensureVoice();
const voiceDir = path.join(work, 'voice');
writeFileSync(path.join(work, 'narration.json'), JSON.stringify({ model: voice.model, config: voice.config, length_scale: 1.06, scenes: Object.entries(NARRATION).map(([id, chunks]) => ({ id, chunks })) }));
execFileSync(voice.py, [path.join(here, 'narrate.py'), 'synth', path.join(work, 'narration.json'), voiceDir], { stdio: 'inherit' });
const VOICE = Object.fromEntries(JSON.parse(readFileSync(path.join(voiceDir, 'manifest.json'), 'utf8')).scenes.map((x) => [x.id, x]));
console.log('narration ready:', Object.values(VOICE).reduce((a, x) => a + x.duration, 0).toFixed(1), 's of speech in', Object.keys(VOICE).length, 'scenes');

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
  await scene('intro', null, 0.4);
  await scene('app', null, 0.5);

  // ---- 2. arm
  const icon = locateToolbarIcon();
  if (!icon) throw new Error('toolbar icon not found');
  let panel, panelOff;
  await scene('arm', async () => {
    await click(icon.x, icon.y, 1100);
    await probe.until(async () => (await probe.state())?.mode === 'armed', 12000);
    panel = await findPage(PORT, 'chrome-extension://' + keyInfo.id + '/sidepanel.html');
    await ripple(panel);
    panelOff = await calibrate(panel, { x: 1420, y: 420 });
    await ripple(page);
  });
  await scene('armed', async () => {
    await glide(panelOff.dx + 190, panelOff.dy + 215, 900);
  });

  // ---- 3. normal testing
  await scene('test', async () => {
    await clickEl(page, tabOff, '[data-add="backpack"]'); await beat(800);
    await clickEl(page, tabOff, '[data-add="tent"]'); await beat(800);
    await clickEl(page, tabOff, '[data-add="lamp"]'); await beat(1200);
    await glide(panelOff.dx + 190, panelOff.dy + 330, 800);
    await beat(4500);
  });

  // ---- 4. instant replay
  await scene('replay', async () => {
    await clickEl(panel, panelOff, '[data-c="saveReplay"]', { ms: 900 });
    await beat(3200);
  });

  // ---- 5. repro session
  await scene('repro', async () => {
    await clickEl(page, tabOff, '#nav-cart', { ms: 800 });
    await beat(1200);
    await clickEl(panel, panelOff, '[data-c="startRepro"]', { ms: 900 });
    await beat(1500);
  });

  // ---- 6. bug 1
  await scene('bug1', async () => {
    await clickEl(page, tabOff, '#promo'); await typeText('summer20', 120); await beat(500);
    await clickEl(page, tabOff, '#apply'); await beat(2200);
  });
  await scene('marker', async () => {
    await clickEl(panel, panelOff, '#markerLabel'); await typeText('Promo discount not applied to total', 55);
    await clickEl(panel, panelOff, '[data-c="marker"]');
    await probe.until(async () => (await probe.dump('shots')).length >= 1, 8000, 250); // the marker screenshot lands asynchronously
    await beat(800);
  });

  // ---- 7. bug 2
  await scene('checkout', async () => {
    await clickEl(page, tabOff, '#checkout-btn', { ms: 800 }); await beat(1500);
    await clickEl(page, tabOff, '#name'); await typeText('Alex Morgan', 90);
    await clickEl(page, tabOff, '#email'); await typeText('alex@example.com', 70);
    await clickEl(page, tabOff, '#card'); await typeText('4242424242424242', 110);
    await clickEl(page, tabOff, '#exp'); await typeText('1228', 110);
    await clickEl(page, tabOff, '#cvv'); await typeText('123', 110); await beat(500);
  });
  // where the card field sits before the error banner appears (the banner pushes the form down)
  const cardPre = await page.eval(`(() => { const r = document.querySelector('#card').getBoundingClientRect(); return [r.x / innerWidth, r.y / innerHeight, (r.x + r.width) / innerWidth, (r.y + r.height) / innerHeight]; })()`);
  await scene('bug2', async () => {
    await clickEl(page, tabOff, '#place'); await beat(2300);
    await clickEl(panel, panelOff, '#markerLabel'); await typeText('Order fails with E-4021', 55);
    await clickEl(panel, panelOff, '[data-c="marker"]');
    const got = await probe.until(async () => (await probe.dump('shots')).length >= 2, 8000, 250); // wait for it before leaving the tab
    if (!got) {
      const evs = (await probe.dump('events')).filter((e) => e.type === 'system' || e.type === 'marker' || e.type === 'screenshot').slice(-8).map((e) => `${e.type}:${e.label}${e.note ? ' (' + e.note + ')' : ''}`);
      console.log('second marker screenshot missing; shots =', (await probe.dump('shots')).length, '; recent events:', evs.join(' | '));
    }
    await beat(600);
  });
  const boxes = await page.eval(`(() => { const n = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x / innerWidth, r.y / innerHeight, (r.x + r.width) / innerWidth, (r.y + r.height) / innerHeight]; }; return { card: n('#card'), err: n('#error .err') }; })()`);
  boxes.cardPre = cardPre;

  // ---- 8. privacy pause
  let blank = null;
  await scene('pause', async () => {
    blank = (await browser.send('Target.createTarget', { url: 'about:blank' })).targetId;
    await beat(3800);
  });
  await scene('resume', async () => {
    await browser.send('Target.closeTarget', { targetId: blank });
    const fix = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith(`http://localhost:${SITE}/`));
    if (fix) await browser.send('Target.activateTarget', { targetId: fix.id });
    await beat(2000);
  });

  // ---- 9. finish and review
  let rv = null;
  await probe.setSettings({ openReviewAfterSave: true }); // the report should open by itself now, but not after the quick replay above
  await scene('finish', async () => {
    await clickEl(panel, panelOff, '[data-c="finishRepro"]', { ms: 900 });
    for (let i = 0; i < 40 && !rv; i++) { await sleep(500); rv = await findPage(PORT, `chrome-extension://${keyInfo.id}/review.html?session=`); }
    if (!rv) throw new Error('Review page did not open');
    await sleep(1200);
    await click(W - 28, 101, 900); // close the side panel: the report gets the whole window
    await sleep(900);
    await ripple(rv);
  });
  await scene('review', async () => {
    await rv.eval(`(() => { const v = document.getElementById('vid'); v.muted = true; v.currentTime = 4; return v.play(); })()`).catch(() => undefined);
    await glide(tabOff.dx + 760, tabOff.dy + 520, 900);
    await beat(2800);
  });
  await scene('timeline', async () => {
    const row = await rv.eval(`(() => { const rows = [...document.querySelectorAll('#tl .tl')]; const i = rows.findIndex((r) => /Place order/i.test(r.textContent)); return i < 0 ? 8 : i; })()`);
    await rv.eval(`document.querySelector('#tl [data-i="${row}"]').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await sleep(400);
    await clickEl(rv, tabOff, `#tl [data-i="${row}"]`, { ms: 900 });
    await beat(1800);
  });

  // ---- 10. screenshot editor
  await smoothTo(rv, '.gallery', 'center');
  await scene('editor', async () => {
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
  await scene('editorSave', async () => {
    await clickEl(rv, tabOff, '#ed-save', { ms: 900 });
    await beat(1500);
  });

  // ---- 11. video privacy tools
  // Video times of the card number: a timeline row click seeks the player, so the rows tell us (video time, pre-session context included).
  const tt = await rv.eval(`(() => { const v = document.getElementById('vid'); const rows = [...document.querySelectorAll('#tl .tl')];
    const at = (re) => { const r = rows.find((x) => re.test(x.textContent)); if (!r) return null; r.click(); return v.currentTime; };
    const out = { card: at(/Card number/), place: at(/Place order/), dur: v.duration }; v.pause(); v.currentTime = 0; return out; })()`);
  if (tt.card == null || tt.place == null || !Number.isFinite(tt.dur)) throw new Error('card / Place order not found in the timeline: ' + JSON.stringify(tt));
  const playerGeo = () => rv.eval(`(() => { const v = document.getElementById('vid'); const r = v.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vw: v.videoWidth, vh: v.videoHeight }; })()`);
  const contentBox = (g) => { const ar = g.vw / g.vh; let cw = g.w, ch = g.h; if (g.w / g.h > ar) cw = g.h * ar; else ch = g.w / ar; return { x: g.x + (g.w - cw) / 2, y: g.y + (g.h - ch) / 2, w: cw, h: ch }; };
  /** A real click on the player's seek bar, then the exact frame. */
  async function seekTo(t) {
    const g = await playerGeo();
    const f = Math.min(1, Math.max(0, t / tt.dur)), inset = 16;
    await click(Math.round(tabOff.dx + g.x + inset + (g.w - 2 * inset) * f), Math.round(tabOff.dy + g.y + g.h - 20), 650);
    await rv.eval(`(() => { const v = document.getElementById('vid'); v.pause(); v.currentTime = ${t.toFixed(3)}; })()`);
    await sleep(700);
  }
  async function maskOver(box) {
    await clickEl(rv, tabOff, '#pt-mask', { ms: 800 });
    await sleep(400);
    const vc = contentBox(await playerGeo());
    const pad = 0.012;
    await drag(pointAt(tabOff, vc, box[0] - pad / 2, box[1] - pad), pointAt(tabOff, vc, box[2] + pad / 2, box[3] + pad), 900);
    await beat(500);
  }
  const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  await smoothTo(rv, '#ptools', 'end');
  await scene('videoFind', async () => {
    await seekTo(tt.place - 0.4); // card, expiry and CVV are typed, the error has not appeared yet
    await beat(1200);
  });
  await scene('videoMask', async () => {
    await maskOver(boxes.cardPre);
    await seekTo(Math.max(0, tt.card - 0.3)); await clickEl(rv, tabOff, '#pt-from-now', { ms: 600 });
    await seekTo(Math.min(tt.dur, tt.place + 2.2)); await clickEl(rv, tabOff, '#pt-to-now', { ms: 600 }); // the banner shows 1.1 s after the click
    await beat(500);
    await clickEl(rv, tabOff, '#pt-add', { ms: 700 }); await beat(700);
  });
  await scene('videoMask2', async () => {
    await maskOver(boxes.card);
    await seekTo(tt.place + 0.2); await clickEl(rv, tabOff, '#pt-from-now', { ms: 600 });
    await clickEl(rv, tabOff, '#pt-to'); selectAll(); await typeText(clock(Math.ceil(tt.dur)), 110); // "until the end": rounded up, never short
    await beat(500);
    await clickEl(rv, tabOff, '#pt-add', { ms: 700 }); await beat(700);
  });
  await scene('videoPreview', async () => {
    await clickEl(rv, tabOff, '#pt-preview', { ms: 800 });
  });
  for (let i = 0; i < 120; i++) { if (await rv.eval(`!!document.querySelector('#pt-form .badge')`)) break; await sleep(500); }
  await sleep(400);
  const masks = await rv.eval(`[...document.querySelectorAll('#pt-list li')].map((li) => li.textContent.trim())`);
  console.log('video masks:', JSON.stringify(masks), 'card typed at', tt.card.toFixed(2), 's, Place order at', tt.place.toFixed(2), 's, duration', tt.dur.toFixed(2), 's');
  await scene('videoDone', async () => {
    const from = Math.max(0, tt.card - 1.2);
    await rv.eval(`(() => { const v = document.getElementById('vid'); v.pause(); v.currentTime = ${from.toFixed(3)}; v.muted = true; return v.play(); })()`).catch(() => undefined);
    await beat(Math.min(11000, (tt.place + 3 - from) * 1000));
    await rv.eval(`document.getElementById('vid').pause()`).catch(() => undefined);
  }, 0.8);
  await clickEl(rv, tabOff, '#pt-preview', { ms: 700 }); await beat(600);

  // ---- 12. report and export
  await smoothTo(rv, '#f-actual', 'center');
  await scene('describe', async () => {
    await clickEl(rv, tabOff, '#f-actual'); await typeText('Promo SUMMER20 shows a discount but the total is unchanged; Place order fails with E-4021.', 35);
    await clickEl(rv, tabOff, '#f-exp'); await typeText('The total includes the discount and the order is placed.', 35);
    await beat(500);
  });
  await smoothTo(rv, '#export', 'center');
  await scene('export', async () => {
    await clickEl(rv, tabOff, '.fmt:has([data-fmt="docx"])', { ms: 800 });
    await beat(400);
    await clickEl(rv, tabOff, '#export', { ms: 800 });
    for (let i = 0; i < 90; i++) { if (readdirSync(dl).filter((f) => !f.endsWith('.crdownload')).length >= 3) break; await sleep(500); }
    await beat(1500);
  });

  // ---- 13. exported report
  const htmlFile = readdirSync(dl).find((f) => f.endsWith('.html'));
  if (htmlFile) {
    await scene('html', async () => {
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
  await scene('closing', async () => {
    await browser.send('Target.createTarget', { url: `chrome-extension://${keyInfo.id}/review.html` });
    await sleep(2500);
  });
  await scene('final', null, 2.2);
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

// captions: one per spoken phrase, on screen while it is spoken (plus a short tail), never overlapping
const caps = [];
for (const [id, start] of Object.entries(timeline).sort((a, b) => a[1] - b[1])) for (const c of VOICE[id].chunks) caps.push({ s: start + c.start, e: start + c.end + 0.45, text: c.show });
caps.forEach((c, i) => { const n = caps[i + 1]; c.e = Math.min(c.e, n ? n.s - 0.04 : dur - 0.3); });
const ts = (t, srt) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; const sec = srt ? s.toFixed(3).replace('.', ',').padStart(6, '0') : s.toFixed(2).padStart(5, '0'); return srt ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}` : `${h}:${String(m).padStart(2, '0')}:${sec}`; };
/** At most two balanced lines, like broadcast / YouTube captions. */
const lines = (text, n = 44) => {
  if (text.length <= n) return [text];
  const mid = text.length / 2;
  let best = -1;
  for (let i = 0; i < text.length; i++) if (text[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best < 0 ? [text] : [text.slice(0, best), text.slice(best + 1)];
};
writeFileSync(path.join(out, 'reprodesk-demo.en.srt'), caps.map((c, i) => `${i + 1}\n${ts(c.s, true)} --> ${ts(c.e, true)}\n${lines(c.text).join('\n')}\n`).join('\n'));
// YouTube look: white text, each line on its own 75 % black box, bottom centre, over the picture
const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: YT,Inter,33,&H00FFFFFF,&H00FFFFFF,&H40000000,&H40000000,0,0,0,0,100,100,0,0,3,8,0,2,40,40,46,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${caps.map((c) => `Dialogue: 0,${ts(c.s, false)},${ts(c.e, false)},YT,,0,0,0,,${lines(c.text).join('\\N')}`).join('\n')}\n`;
const assFile = path.join(work, 'captions.ass');
writeFileSync(assFile, ass);

// voice track: every scene's narration placed at the moment its scene started, then loudness-normalized
writeFileSync(path.join(work, 'timeline.json'), JSON.stringify(timeline));
const narration = path.join(work, 'narration.wav');
execFileSync(voice.py, [path.join(here, 'narrate.py'), 'mix', path.join(voiceDir, 'manifest.json'), path.join(work, 'timeline.json'), narration, String(dur)]);
const vfade = `fade=t=in:st=0:d=0.5,fade=t=out:st=${(dur - 0.7).toFixed(2)}:d=0.7`;
const afilt = `loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,afade=t=in:st=0:d=0.3,afade=t=out:st=${(dur - 0.7).toFixed(2)}:d=0.7`;
const enc = ['-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '1', '-movflags', '+faststart', '-shortest'];
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-i', narration, '-vf', vfade, '-af', afilt, ...enc, path.join(out, 'reprodesk-demo.mp4')]);
const fontDir = '/usr/share/fonts/opentype/inter';
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-i', narration, '-vf', `subtitles=${assFile}:fontsdir=${fontDir},${vfade}`, '-af', afilt, ...enc, path.join(out, 'reprodesk-demo-subtitles.mp4')]);
console.log(`film done: ${dur.toFixed(1)} s, ${caps.length} captions -> docs/demo/reprodesk-demo.mp4 (voice), reprodesk-demo-subtitles.mp4 (voice + captions), reprodesk-demo.en.srt`);
if (!process.env.FILM_KEEP) rmSync(work, { recursive: true, force: true });
