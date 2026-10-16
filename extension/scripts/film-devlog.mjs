// Short feature film: the Console & network log. Same rig as scripts/film.mjs (headed Chromium under Xvfb, real clicks through
// xdotool, Piper voice-over, YouTube-style captions), one scenario: switch the log on, place a failing order in the demo shop,
// find the failed request and the console error in Review, see what the filters removed, export.
// Output: docs/demo/reprodesk-devlog.mp4 (voice-over + captions).   npm run demo:film:devlog   (needs what film.mjs needs)
import { startDisplay, launchChrome, tmpProfile, rmProfile, sleep, xdo, findPage, browserCdp, locateToolbarIcon, keyInfo, DISPLAY } from '../tests/real/lib.mjs';
import { makeProbe } from '../tests/real/probe.mjs';
import { startDemoSite } from './demo-site.mjs';
import path from 'node:path';
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../docs/demo');
const PORT = Number(process.env.RD_PORT ?? 9334), SITE = Number(process.env.RD_SITE ?? 5173);
const W = 1500, H = 940, FPS = 30;
const work = path.join(out, '.film-devlog');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const dl = path.join(work, 'dl');
mkdirSync(dl, { recursive: true });

// ------------------------------------------------------------------ pointer and ripples (as in film.mjs)
const PACE = Number(process.env.FILM_PACE ?? 0.78);
const beat = (ms) => sleep(ms * PACE);
let cur = { x: 760, y: 520 };
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
async function glide(x, y, ms = 700) {
  ms *= PACE;
  const steps = Math.max(10, Math.round(ms / 20));
  const from = { ...cur };
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    xdo('mousemove', String(Math.round(from.x + (x - from.x) * t)), String(Math.round(from.y + (y - from.y) * t)));
    await sleep(ms / steps);
  }
  cur = { x, y };
}
async function click(x, y, ms) { await glide(x, y, ms); await sleep(160); xdo('click', '1'); await sleep(260); }
const typeText = async (text, delay = 80) => { xdo('type', '--delay', String(Math.max(35, Math.round(delay * PACE))), text); await sleep(200); };
const RIPPLE = `(() => { if (window.__rip) return; window.__rip = 1;
  const st = document.createElement('style');
  st.textContent = '@keyframes rdrip{from{transform:translate(-50%,-50%) scale(.3);opacity:.9}to{transform:translate(-50%,-50%) scale(1.8);opacity:0}}.rdrip{position:fixed;z-index:2147483647;width:44px;height:44px;border-radius:50%;border:3px solid #ff6b35;background:rgba(255,107,53,.22);pointer-events:none;animation:rdrip .6s ease-out forwards}';
  document.documentElement.appendChild(st);
  addEventListener('pointerdown', (e) => { const d = document.createElement('div'); d.className = 'rdrip'; d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; document.documentElement.appendChild(d); setTimeout(() => d.remove(), 750); }, true);
})()`;
const ripple = (page) => page.eval(RIPPLE).catch(() => undefined);
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
async function smoothTo(page, sel, block = 'center') {
  await page.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: ${JSON.stringify(block)}, behavior: 'smooth' })`);
  await sleep(500);
  let last = -1;
  for (let i = 0; i < 30; i++) { const y = await page.eval(`Math.round(window.scrollY)`); if (y === last) break; last = y; await sleep(120); }
  await sleep(250);
}
async function clickEl(page, off, sel, { ms = 700, scroll = true, dx = 0.5, dy = 0.5 } = {}) {
  const r = await rectOf(page, sel, scroll);
  if (!r) throw new Error('element not found: ' + sel);
  await click(Math.round(off.dx + r.x + r.w * dx), Math.round(off.dy + r.y + r.h * dy), ms);
}
async function glideTo(page, off, sel, fx = 0.5, fy = 0.5, ms = 800) {
  const r = await rectOf(page, sel, false);
  if (r) await glide(Math.round(off.dx + r.x + r.w * fx), Math.round(off.dy + r.y + r.h * fy), ms);
}

// ------------------------------------------------------------------ narration: spoken text -> caption text
const C = (say, show = say) => ({ say, show });
const NARRATION = {
  intro: [C('New in [[ ɹˈɛpɹoʊdˌɛsk: ]] the console and network log.', 'New in ReproDesk: the console & network log.'), C('What the browser saw, in sync with the replay.')],
  setting: [C('It is off by default.'), C('Arm [[ ɹˈɛpɹoʊdˌɛsk, ]] and open Settings.', 'Arm ReproDesk and open Settings.')],
  switch: [C('Switch on the console and network log.', 'Switch on Console & network log.'), C('Administrators can also turn it on, or forbid it, with a policy.')],
  repro: [C('Start a [[ ɹˈɛpɹoʊ ]] Session, and place an order.', 'Start a Repro Session and place an order.')],
  fail: [C('The order fails with error E, forty twenty one.', 'The order fails with error E-4021.'), C('On screen, that is all the tester sees.')],
  finish: [C('Finish and review.', 'Finish & review.')],
  timeline: [C('The timeline now shows what the page logged, right after the click on Place order:'), C('the failed request to the orders API, status five oh two, and the console error.', 'the failed request to the orders API, status 502, and the console error.')],
  jump: [C('Click a row, and the video jumps to that moment.')],
  panel: [C('The console and network panel lists every message and every request.', 'The Console & network panel lists every message and every request.'), C('Problems only hides the noise.')],
  privacy: [C('Everything is filtered on this device, before it is stored.'), C("The buyer's email is redacted.")],
  privacy2: [C('The session id in the URL is dropped,', 'The session ID in the URL is dropped,'), C('and request bodies, headers and cookies are never collected.')],
  export: [C('Every export lists the errors.'), C('The zip adds the full log, with an H A R file that opens in Chrome dev tools.', 'The ZIP adds the full log, with a HAR file that opens in Chrome DevTools.')],
  report: [C('And the H T M L report shows it next to the steps and the video.', 'And the HTML report shows it next to the steps and the video.')],
  final: [C('[[ ɹˈɛpɹoʊdˌɛsk: ]] what the tester saw, and what the browser saw.', 'ReproDesk: what the tester saw, and what the browser saw.')],
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
writeFileSync(path.join(work, 'narration.json'), JSON.stringify({ model: voice.model, config: voice.config, length_scale: 0.97, scenes: Object.entries(NARRATION).map(([id, chunks]) => ({ id, chunks })) }));
execFileSync(voice.py, [path.join(here, 'narrate.py'), 'synth', path.join(work, 'narration.json'), voiceDir], { stdio: 'inherit' });
const VOICE = Object.fromEntries(JSON.parse(readFileSync(path.join(voiceDir, 'manifest.json'), 'utf8')).scenes.map((x) => [x.id, x]));

let recStartWall = 0;
const vt = () => (Date.now() - recStartWall) / 1000;
const timeline = {};
const fast = [];
async function scene(id, fn, extra = 0.35) {
  timeline[id] = vt();
  const t0 = Date.now();
  if (fn) await fn();
  const rest = (VOICE[id].duration + extra) * 1000 - (Date.now() - t0);
  if (rest > 0) await sleep(rest);
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
  // the log starts off, as it does for every user; a 0 s pre-session keeps the report to the scenario itself
  await probe.setSettings({ replaySec: 90, tailSec: 3, preSessionSec: 0, fps: 15, bitrateKbps: 2500, afkMinutes: 0, openReviewAfterSave: false, environment: 'QA · staging', markerScreenshot: false, captureLogs: false });
  browser = await browserCdp(PORT);
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: false });
  const page = await findPage(PORT, `http://localhost:${SITE}/`);
  await ripple(page);
  const tabOff = await calibrate(page, { x: 420, y: 420 });
  await sleep(500);

  const raw = path.join(work, 'raw.mp4');
  rec = spawn('ffmpeg', ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-f', 'x11grab', '-framerate', String(FPS), '-video_size', `${W}x${H}`, '-draw_mouse', '1', '-i', `${DISPLAY}.0+0,0`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', raw], { stdio: ['pipe', 'pipe', 'inherit'] });
  rec.stdout.on('data', (d) => { for (const m of String(d).matchAll(/out_time_us=(\d+)/g)) recStartWall = Date.now() - Number(m[1]) / 1000; });
  for (let i = 0; i < 150 && !recStartWall; i++) await sleep(100);
  if (!recStartWall) throw new Error('screen recorder did not start');
  await sleep(600);

  await scene('intro', async () => { await glide(700, 480, 1200); }, 0.4);

  // ---- switch it on
  const icon = locateToolbarIcon();
  if (!icon) throw new Error('toolbar icon not found');
  let panel, panelOff;
  await scene('setting', async () => {
    await beat(600);
    await click(icon.x, icon.y, 1000);
    await probe.until(async () => (await probe.state())?.mode === 'armed', 12000);
    panel = await findPage(PORT, 'chrome-extension://' + keyInfo.id + '/sidepanel.html');
    await ripple(panel);
    panelOff = await calibrate(panel, { x: 1420, y: 420 });
    await beat(700);
    await clickEl(panel, panelOff, '[data-nav="settings"]', { ms: 900 });
    await beat(900);
    await panel.eval(`document.querySelector('[data-sb="captureLogs"]').closest('.setrow').scrollIntoView({ block: 'center', behavior: 'smooth' })`);
    await beat(900);
  }, 0.2);
  await scene('switch', async () => {
    await glideTo(panel, panelOff, '.setrow:has([data-sb="captureLogs"]) .t', 0.4, 0.5, 800);
    await beat(300);
    await clickEl(panel, panelOff, '.switch:has([data-sb="captureLogs"])', { ms: 600, scroll: false });
    await probe.until(() => panel.eval(`document.querySelector('[data-sb="captureLogs"]')?.checked === true`), 5000, 200);
    await beat(1600);
  });

  // ---- the scenario
  await scene('repro', async () => {
    await clickEl(panel, panelOff, '[data-nav="main"]', { ms: 800 });
    await beat(500);
    await clickEl(page, tabOff, '[data-add="backpack"]'); await beat(500);
    await clickEl(page, tabOff, '#nav-cart', { ms: 700 }); await beat(700);
    await clickEl(panel, panelOff, '[data-c="startRepro"]', { ms: 800 }); await beat(900);
    await clickEl(page, tabOff, '#checkout-btn', { ms: 800 }); await beat(900);
    await clickEl(page, tabOff, '#name'); await typeText('Alex Morgan', 70);
    await clickEl(page, tabOff, '#email'); await typeText('alex.morgan@example.com', 55);
    await beat(300);
  }, 0.2);
  await scene('fail', async () => {
    await clickEl(page, tabOff, '#place', { ms: 800 });
    await beat(1800);
    await glideTo(page, tabOff, '#error .err', 0.5, 0.5, 900);
    await beat(1200);
  });

  // ---- review
  let rv = null;
  await scene('finish', async () => {
    await clickEl(panel, panelOff, '[data-c="finishRepro"]', { ms: 900 });
    for (let i = 0; i < 40 && !rv; i++) { await sleep(500); rv = await findPage(PORT, `chrome-extension://${keyInfo.id}/review.html?session=`); }
    if (!rv) throw new Error('Review page did not open');
    await sleep(1200);
    await click(W - 28, 101, 800); // close the side panel: the report gets the whole window
    await sleep(700);
    await ripple(rv);
  });
  // the timeline row of the failed request, with the console error right after it
  const rowIdx = (re) => rv.eval(`[...document.querySelectorAll('#tl .tl')].findIndex((r) => ${re}.test(r.textContent))`);
  await smoothTo(rv, '#tl', 'center');
  const reqRow = await rowIdx('/Request failed/');
  const errRow = await rowIdx('/Console error/');
  if (reqRow < 0 || errRow < 0) throw new Error('log rows missing from the timeline');
  await rv.eval(`document.querySelector('#tl [data-i="${reqRow}"]').scrollIntoView({ block: 'center', behavior: 'smooth' })`);
  await sleep(700);
  await scene('timeline', async () => {
    const place = await rowIdx('/Place order/');
    if (place >= 0) { await glideTo(rv, tabOff, `#tl [data-i="${place}"] .tx`, 0.25, 0.5, 900); await beat(1400); }
    await glideTo(rv, tabOff, `#tl [data-i="${reqRow}"] .tx`, 0.35, 0.5, 900); await beat(2200);
    await glideTo(rv, tabOff, `#tl [data-i="${errRow}"] .tx`, 0.35, 0.5, 700); await beat(1500);
  });
  await scene('jump', async () => {
    await rv.eval(`(() => { const v = document.getElementById('vid'); v.muted = true; v.pause(); v.currentTime = 0; })()`);
    await clickEl(rv, tabOff, `#tl [data-i="${reqRow}"]`, { ms: 700, scroll: false });
    await smoothTo(rv, '#stage', 'center');
    await rv.eval(`document.getElementById('vid').play().catch(() => undefined)`);
    await glideTo(rv, tabOff, '#stage', 0.5, 0.85, 800);
    await beat(2600);
    await rv.eval(`document.getElementById('vid').pause()`);
  });

  // ---- the panel
  // The panel is the last thing on the page: room below it lets it scroll up, so its rows stay above the captions.
  await rv.eval(`document.body.style.paddingBottom = '380px'`);
  await smoothTo(rv, '#devlog', 'start');
  await scene('panel', async () => {
    await clickEl(rv, tabOff, '[data-logtab="network"]', { ms: 800 }); await beat(1500);
    await clickEl(rv, tabOff, '#logprob', { ms: 700 }); await beat(1600);
    await clickEl(rv, tabOff, '[data-logtab="console"]', { ms: 700 }); await beat(1200);
  });
  /** Tags the log row whose text contains `text`, so the pointer can go exactly there. */
  const markRow = (text) => rv.eval(`(() => { document.querySelectorAll('[data-film]').forEach((x) => x.removeAttribute('data-film')); const r = [...document.querySelectorAll('#loglist .lg')].find((x) => x.textContent.includes(${JSON.stringify(text)})); r?.setAttribute('data-film', '1'); return !!r; })()`);
  await scene('privacy', async () => {
    await clickEl(rv, tabOff, '#logprob', { ms: 600 }); await beat(700); // all messages again: the email line is an info message
    if (await markRow('placing order')) await glideTo(rv, tabOff, '[data-film] .m', 0.45, 0.5, 900);
    await beat(1500);
  });
  await scene('privacy2', async () => {
    await clickEl(rv, tabOff, '[data-logtab="network"]', { ms: 700 }); await beat(600);
    if (await markRow('/api/orders')) await glideTo(rv, tabOff, '[data-film] .m', 0.55, 0.3, 900);
    await beat(2400);
  });

  // ---- export
  await rv.eval(`document.getElementById('export').closest('section').scrollIntoView({ block: 'center', behavior: 'smooth' })`);
  await sleep(1200);
  await scene('export', async () => {
    await glideTo(rv, tabOff, '.setrow:has(#inc-logs) .t', 0.4, 0.5, 900); await beat(1200);
    await clickEl(rv, tabOff, '#export', { ms: 800 });
    const from = Math.max(vt(), timeline.export + VOICE.export.duration + 0.4);
    for (let i = 0; i < 90; i++) { if (readdirSync(dl).filter((f) => !f.endsWith('.crdownload')).length >= 2) break; await sleep(500); }
    if (vt() - from > 1) fast.push([from, vt() - 0.2]);
    await beat(1200);
  });
  const htmlFile = readdirSync(dl).find((f) => f.endsWith('.html'));
  if (!htmlFile) throw new Error('HTML report was not exported');
  await scene('report', async () => {
    await browser.send('Target.createTarget', { url: 'file://' + path.join(dl, htmlFile) });
    await sleep(2000);
    const rp = await findPage(PORT, 'file://');
    await rp.eval(`(() => { const h = [...document.querySelectorAll('h2')].find((x) => /Console/.test(x.textContent)); h?.scrollIntoView({ block: 'start', behavior: 'smooth' }); })()`);
    await beat(1800);
    await rp.eval(`(() => { const d = [...document.querySelectorAll('details.log')].at(-1); if (d) d.open = true; })()`);
    await beat(2500);
  });
  await scene('final', null, 2.0);
  await sleep(500);
} catch (e) {
  console.error('film aborted:', e instanceof Error ? e.stack : e);
  process.exitCode = 1;
} finally {
  if (rec) { rec.stdin.write('q'); await new Promise((r) => { rec.on('exit', r); setTimeout(r, 8000); }); }
  browser?.close();
  await chrome.close(); disp.stop(); site.close(); rmProfile(ud);
}
if (process.exitCode) process.exit(process.exitCode);

// ------------------------------------------------------------------ post-production (as in film.mjs)
const raw = path.join(work, 'raw.mp4');
const SPEED = Number(process.env.FILM_FAST ?? 2);
let src = raw;
if (fast.length && SPEED > 1) {
  const parts = [];
  let t = 0;
  for (const [a, b] of fast) { if (a > t) parts.push([t, a, 1]); parts.push([a, b, SPEED]); t = b; }
  parts.push([t, null, 1]);
  const graph = parts.map(([a, b, k], i) => `[0:v]trim=start=${a.toFixed(3)}${b != null ? `:end=${b.toFixed(3)}` : ''},setpts=(PTS-STARTPTS)/${k}[p${i}]`).join(';')
    + ';' + parts.map((_, i) => `[p${i}]`).join('') + `concat=n=${parts.length}:v=1:a=0,fps=${FPS}[v]`;
  src = path.join(work, 'paced.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-filter_complex', graph, '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', src]);
  const saved = (x) => fast.reduce((d, [a, b]) => d + Math.max(0, Math.min(x, b) - a) * (1 - 1 / SPEED), 0);
  for (const k of Object.keys(timeline)) timeline[k] -= saved(timeline[k]);
}
const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src]).toString());
const caps = [];
for (const [id, start] of Object.entries(timeline).sort((a, b) => a[1] - b[1])) for (const c of VOICE[id].chunks) caps.push({ s: start + c.start, e: start + c.end + 0.45, text: c.show });
caps.forEach((c, i) => { const n = caps[i + 1]; c.e = Math.min(c.e, n ? n.s - 0.04 : dur - 0.3); });
const ts = (t) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`; };
const lines = (text, n = 44) => {
  if (text.length <= n) return [text];
  const mid = text.length / 2;
  const spaces = [...text].map((c, i) => (c === ' ' ? i : -1)).filter((i) => i > 0);
  const fits = (i) => i <= n + 4 && text.length - i - 1 <= n + 4;
  const punct = spaces.filter((i) => /[,:;.]/.test(text[i - 1]) && fits(i));
  let best = -1;
  for (const i of punct.length ? punct : spaces) if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
  return best < 0 ? [text] : [text.slice(0, best), text.slice(best + 1)];
};
const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: YT,Inter,34,&H00FFFFFF,&H00FFFFFF,&H00141414,&H8C000000,0,0,0,0,100,100,0,0,1,2.6,1.4,2,40,40,46,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${caps.map((c) => `Dialogue: 0,${ts(c.s)},${ts(c.e)},YT,,0,0,0,,${lines(c.text).join('\\N')}`).join('\n')}\n`;
const assFile = path.join(work, 'captions.ass');
writeFileSync(assFile, ass);
writeFileSync(path.join(work, 'timeline.json'), JSON.stringify(timeline));
const narration = path.join(work, 'narration.wav');
execFileSync(voice.py, [path.join(here, 'narrate.py'), 'mix', path.join(voiceDir, 'manifest.json'), path.join(work, 'timeline.json'), narration, String(dur)]);
const vfade = `fade=t=in:st=0:d=0.5,fade=t=out:st=${(dur - 0.7).toFixed(2)}:d=0.7`;
const afilt = `loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,afade=t=in:st=0:d=0.3,afade=t=out:st=${(dur - 0.7).toFixed(2)}:d=0.7`;
const target = path.join(out, 'reprodesk-devlog.mp4');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-i', narration, '-vf', `subtitles=${assFile}:fontsdir=/usr/share/fonts/opentype/inter,${vfade}`, '-af', afilt,
  '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-movflags', '+faststart', '-shortest', target]);
console.log(`devlog film done: ${dur.toFixed(1)} s, ${caps.length} captions -> docs/demo/reprodesk-devlog.mp4`);
if (!process.env.FILM_KEEP) rmSync(work, { recursive: true, force: true });
