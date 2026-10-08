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
  return sleep(1200).then(async () => {
    procs.push(spawn('openbox', [], { env: { ...process.env, DISPLAY }, stdio: 'ignore' }));
    // Chromium decides at startup whether to draw its own frame: if no EWMH window manager has announced itself yet it falls back to
    // the system title bar and the whole toolbar moves down. On a busy CI runner Chromium regularly won that race, so wait for openbox.
    for (let i = 0; i < 50; i++) {
      try { execFileSync('xdotool', ['get_num_desktops'], { env: { ...process.env, DISPLAY }, stdio: 'ignore' }); break; } catch { await sleep(100); }
    }
    return { stop: () => procs.forEach((p) => p.kill()) };
  });
}

export const xdo = (...args) => execFileSync('xdotool', args, { env: { ...process.env, DISPLAY } }).toString().trim();
export const shot = (file) => execFileSync('import', ['-window', 'root', file], { env: { ...process.env, DISPLAY } });

export async function launchChrome({ userData, port = 9333, startUrl = 'about:blank', extraArgs = [], width = 1400, height = 900, loadExtension = true, webgl = false }) {
  mkdirSync(path.join(userData, 'Default'), { recursive: true });
  const prefs = path.join(userData, 'Default', 'Preferences');
  if (!existsSync(prefs)) writeFileSync(prefs, JSON.stringify({ extensions: { pinned_extensions: [keyInfo.id] }, browser: { has_seen_welcome_page: true, custom_chrome_frame: true }, credentials_enable_service: false, profile: { password_manager_enabled: false }, autofill: { credit_card_enabled: false, profile_enabled: false } }));
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
  const r = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'center', behavior: 'instant' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, sx: window.screenX, sy: window.screenY, top: window.outerHeight - window.innerHeight - 4, left: 4 }; })()`);
  xdo('mousemove', String(Math.round(r.sx + r.left + r.x)), String(Math.round(r.sy + r.top + r.y)));
  await sleep(120);
  xdo('click', '1');
  await sleep(250);
}

/** Finds the pinned ReproDesk icon by its indigo brand tile in the toolbar band (the toolbar layout shifts: side panel, download button, ...).
 *  Returns the centre of the tile, or null. */
export function locateToolbarIcon() {
  const f = path.join(tmpdir(), `rd-toolbar-${process.pid}.png`);
  shot(f);
  const out = JSON.parse(execFileSync('python3', ['-c', `
import json
from PIL import Image
im = Image.open(${JSON.stringify(f)}).convert('RGB'); px = im.load(); pts = []
for y in range(40, 112):
    for x in range(700, im.size[0]):
        r,g,b = px[x,y]
        if 30<=r<=115 and 50<=g<=140 and 190<=b<=255 and b-g>=60: pts.append((x, y))  # the indigo brand tile
# 2-D clusters (pixels within 3 px belong together): the toolbar icon, the side panel's own logo below it, ...
parent = list(range(len(pts)))
def find(i):
    while parent[i] != i: parent[i] = parent[parent[i]]; i = parent[i]
    return i
idx = {p: i for i, p in enumerate(pts)}
for i, (x, y) in enumerate(pts):
    for dx in range(-3, 4):
        for dy in range(-3, 4):
            j = idx.get((x + dx, y + dy))
            if j is not None: parent[find(i)] = find(j)
groups = {}
for i, p in enumerate(pts): groups.setdefault(find(i), []).append(p)
def box(c): xs = [p[0] for p in c]; ys = [p[1] for p in c]; return [min(xs), max(xs), min(ys), max(ys), len(c)]
cl = sorted(groups.values(), key=lambda c: (box(c)[2], box(c)[0]))
icons = [c for c in cl if len(c) >= 40 and box(c)[1] - box(c)[0] <= 30 and box(c)[3] - box(c)[2] <= 26]
hit = icons[0] if icons else None  # the toolbar sits above everything else in this band
print(json.dumps({'x': round(sum(p[0] for p in hit) / len(hit)) if hit else -1, 'y': round(sum(p[1] for p in hit) / len(hit)) if hit else -1, 'clusters': [box(c) for c in cl][:8]}))`]).toString());
  if (process.env.RD_DEBUG_TOOLBAR || out.x < 0) console.log(`INFO  toolbar icon search: x=${out.x} y=${out.y} clusters=${JSON.stringify(out.clusters)}`);
  return out.x < 0 ? null : { x: out.x, y: out.y };
}
export const clickToolbarIcon = async () => {
  let at = null;
  for (let i = 0; i < 10 && !at; i++) { at = locateToolbarIcon(); if (!at) await sleep(500); } // a slow machine paints the pinned icon late
  if (!at) { screenMap('toolbar icon not found'); throw new Error('ReproDesk toolbar icon not found on screen'); }
  xdo('mousemove', String(at.x), String(at.y));
  await sleep(150);
  xdo('click', '1');
};

/** Prints the screen as text (a CI log is often the only thing that leaves the runner): visible windows with geometry, then a coarse
 *  colour map of the whole screen and a fine one of the toolbar band. Legend: # brand indigo, b other blue, k dark, - grey, . light, o other. */
export function screenMap(label) {
  const f = path.join(tmpdir(), `rd-map-${process.pid}.png`);
  shot(f);
  let wins = '';
  try {
    const ids = xdo('search', '--onlyvisible', '--name', '.').split('\n').filter(Boolean).slice(0, 12);
    wins = ids.map((id) => { try { return `${id} "${xdo('getwindowname', id)}" ${xdo('getwindowgeometry', id).split('\n').slice(1).map((l) => l.trim()).join(' ')}`; } catch { return id; } }).join('\n');
  } catch { wins = '(xdotool search failed)'; }
  const map = execFileSync('python3', ['-c', `
from PIL import Image
im = Image.open(${JSON.stringify(f)}).convert('RGB'); W, H = im.size; px = im.load()
def c(x, y):
    r,g,b = px[x,y]; l = (r+g+b)/3
    if 30<=r<=115 and 50<=g<=140 and 190<=b<=255 and b-g>=60: return '#'
    if b > r+40 and b > g+20: return 'b'
    if l < 60: return 'k'
    if l > 200 and max(r,g,b)-min(r,g,b) < 30: return '.'
    if max(r,g,b)-min(r,g,b) < 30: return '-'
    return 'o'
print('screen %dx%d, 20px blocks:' % (W, H))
for y in range(0, H, 20): print(''.join(c(x, y+10 if y+10 < H else y) for x in range(0, W, 20)))
print('toolbar band x=600..%d step 5, y=30..110 step 4:' % W)
for y in range(30, 110, 4): print('%3d ' % y + ''.join(c(x, y) for x in range(600, W, 5)))`]).toString();
  console.log(`---- screen map: ${label}\nwindows:\n${wins}\n${map}---- end screen map`);
}

/** Exports the Evidence Package ZIP of a session through the real Review page and returns the saved file path. */
export async function exportZip(port, sessionId, dir, fmt = 'zip') {
  const { mkdirSync, readdirSync, rmSync } = await import('node:fs');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const b = await browserCdp(port);
  await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: false });
  const rv = await openBackgroundPage(port, `chrome-extension://${keyInfo.id}/review.html?session=${encodeURIComponent(sessionId)}`);
  for (let i = 0; i < 40; i++) { if (await rv.eval(`!!document.getElementById('export')`)) break; await sleep(500); }
  await sleep(1500);
  await rv.eval(`document.querySelectorAll('[data-fmt]').forEach((c) => (c.checked = c.dataset.fmt === ${JSON.stringify(fmt)})); document.getElementById('export').click();`, { gesture: true });
  for (let i = 0; i < 60; i++) { const f = readdirSync(dir).find((x) => x.endsWith('.' + fmt)); if (f) { await sleep(800); rv.close(); b.close(); return path.join(dir, f); } await sleep(500); }
  rv.close(); b.close();
  return null;
}

/** Real mouse click on an element inside the side panel (panel content origin on a 1400x900 window with the default layout). */
export async function panelClick(panel, selector, origin = { x: 1027, y: 121 }) {
  const r = await panel.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  xdo('mousemove', String(Math.round(origin.x + r.x)), String(Math.round(origin.y + r.y)));
  await sleep(150);
  xdo('click', '1');
}
