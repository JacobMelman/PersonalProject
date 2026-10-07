// "Real browser" harness: headed Chromium under Xvfb + openbox, driven by genuine X11 input (xdotool) and a raw CDP client
// attached to PAGE targets only (no debugger on the extension service worker, so Chrome can recycle it like in real life).
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.dirname(fileURLToPath(import.meta.url));
export const proj = path.resolve(root, '../..');
export const dist = process.env.RD_DIST || path.join(proj, 'dist'); // RD_DIST lets a long soak run from a copy while dist/ is rebuilt
export const keyInfo = JSON.parse(readFileSync(path.join(proj, 'manifest.key.json'), 'utf8'));
export const CHROME = process.env.CHROME_BIN || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
export const DISPLAY = process.env.RD_DISPLAY || ':99';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function newReporter() {
  const results = [];
  const ok = (name, cond, extra = '') => {
    results.push({ name, ok: !!cond, extra });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  - ' + extra : ''}`);
  };
  const info = (name, value) => { results.push({ name, ok: true, info: true, extra: String(value) }); console.log(`INFO  ${name}: ${value}`); };
  return { ok, info, results, failed: () => results.filter((r) => !r.ok).length, summary: () => { const f = results.filter((r) => !r.ok).length; console.log(`\n${results.filter((r) => r.ok && !r.info).length}/${results.filter((r) => !r.info).length} checks passed${f ? `, ${f} failure(s)` : ''}`); return f; } };
}

export function startDisplay(size = '1600x1000x24') {
  const procs = [];
  if (!existsSync(`/tmp/.X11-unix/X${DISPLAY.slice(1)}`)) {
    procs.push(spawn('Xvfb', [DISPLAY, '-screen', '0', size, '-ac', '+extension', 'MIT-SCREEN-SAVER'], { stdio: 'ignore' }));
  }
  return sleep(1200).then(() => {
    procs.push(spawn('openbox', [], { env: { ...process.env, DISPLAY }, stdio: 'ignore' }));
    return { stop: () => procs.forEach((p) => p.kill()) };
  });
}

export const xdo = (...args) => execFileSync('xdotool', args, { env: { ...process.env, DISPLAY } }).toString().trim();
export const shot = (file) => execFileSync('import', ['-window', 'root', file], { env: { ...process.env, DISPLAY } });

export async function launchChrome({ userData, port = 9333, startUrl = 'about:blank', extraArgs = [], width = 1400, height = 900, loadExtension = true, webgl = false }) {
  mkdirSync(path.join(userData, 'Default'), { recursive: true });
  const prefs = path.join(userData, 'Default', 'Preferences');
  if (!existsSync(prefs)) writeFileSync(prefs, JSON.stringify({ extensions: { pinned_extensions: [keyInfo.id] }, browser: { has_seen_welcome_page: true } }));
  const args = [
    `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    `--window-position=0,0`, `--window-size=${width},${height}`, '--disable-features=Translate,MediaRouter', '--password-store=basic',
    '--use-mock-keychain', '--disable-search-engine-choice-screen', '--test-type',
    ...(loadExtension ? [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] : []),
    ...(webgl ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : []),
    ...extraArgs, startUrl,
  ];
  const proc = spawn(CHROME, args, { env: { ...process.env, DISPLAY, GOOGLE_API_KEY: 'no', GOOGLE_DEFAULT_CLIENT_ID: 'no', GOOGLE_DEFAULT_CLIENT_SECRET: 'no' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => (err += d));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch { /* not up yet */ }
    await sleep(500);
  }
  return {
    proc, port, stderr: () => err,
    kill: () => proc.kill('SIGKILL'),
    close: async () => { proc.kill('SIGTERM'); await sleep(1500); proc.kill('SIGKILL'); },
    targets: async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()),
  };
}

/** Minimal CDP client over the global WebSocket (Node 22). */
export async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  return {
    send,
    eval: async (expression, opts = {}) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: !!opts.gesture }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; },
    close: () => ws.close(),
  };
}

export const tmpProfile = () => mkdtempSync(path.join(tmpdir(), 'rd-real-'));
export const rmProfile = (d) => existsSync(d) && rmSync(d, { recursive: true, force: true });

export async function browserCdp(port) {
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return cdpConnect(v.webSocketDebuggerUrl);
}

/** Opens a background tab (does not steal focus, so it does not trigger Privacy Pause) and returns a CDP session on it. */
export async function openBackgroundPage(port, url) {
  const b = await browserCdp(port);
  const { targetId } = await b.send('Target.createTarget', { url, background: true });
  b.close();
  for (let i = 0; i < 20; i++) {
    const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.id === targetId);
    if (t) return cdpConnect(t.webSocketDebuggerUrl);
    await sleep(250);
  }
  throw new Error('background page not found');
}

export async function findPage(port, startsWith) {
  const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page' && x.url.startsWith(startsWith));
  return t ? cdpConnect(t.webSocketDebuggerUrl) : null;
}

/** Real mouse click on a DOM element: its rect is translated to screen coordinates and clicked with xdotool. */
export async function realClick(page, selector) {
  const r = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, sx: window.screenX, sy: window.screenY, top: window.outerHeight - window.innerHeight - 4, left: 4 }; })()`);
  xdo('mousemove', String(Math.round(r.sx + r.left + r.x)), String(Math.round(r.sy + r.top + r.y)));
  await sleep(120);
  xdo('click', '1');
  await sleep(250);
}

/** Finds the pinned ReproDesk icon by its red record dot in the toolbar band (the toolbar layout shifts: side panel, download button, ...). */
export function locateToolbarIcon() {
  const f = path.join(tmpdir(), `rd-toolbar-${process.pid}.png`);
  shot(f);
  const out = execFileSync('python3', ['-c', `
from PIL import Image
im = Image.open(${JSON.stringify(f)}).convert('RGB'); px = im.load(); xs = []
for y in range(48, 80):
    for x in range(700, im.size[0]):
        r,g,b = px[x,y]
        if abs(r-229)<12 and abs(g-57)<12 and abs(b-53)<12: xs.append(x)
print(round(sum(xs)/len(xs)) if xs else -1)`]).toString().trim();
  return Number(out);
}
export const clickToolbarIcon = async () => {
  const x = locateToolbarIcon();
  if (x < 0) throw new Error('ReproDesk toolbar icon not found on screen');
  xdo('mousemove', String(x), '63');
  await sleep(150);
  xdo('click', '1');
};

/** Exports the Evidence Package ZIP of a session through the real Review page and returns the saved file path. */
export async function exportZip(port, sessionId, dir) {
  const { mkdirSync, readdirSync, rmSync } = await import('node:fs');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const b = await browserCdp(port);
  await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: false });
  const rv = await openBackgroundPage(port, `chrome-extension://${keyInfo.id}/review.html?session=${encodeURIComponent(sessionId)}`);
  for (let i = 0; i < 40; i++) { if (await rv.eval(`!!document.getElementById('export')`)) break; await sleep(500); }
  await sleep(1500);
  await rv.eval(`document.querySelectorAll('[data-fmt]').forEach((c) => (c.checked = c.dataset.fmt === 'zip')); document.getElementById('export').click();`, { gesture: true });
  for (let i = 0; i < 60; i++) { const f = readdirSync(dir).find((x) => x.endsWith('.zip')); if (f) { await sleep(800); rv.close(); b.close(); return path.join(dir, f); } await sleep(500); }
  rv.close(); b.close();
  return null;
}
