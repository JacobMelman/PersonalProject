// B0.13: does pixel video preserve what DOM-based capture cannot see? Difficult enterprise-style rendering in real Chromium:
// WebGL, 2D canvas, same/cross-origin iframes, Shadow DOM, a 200k-row virtualised grid and high-frequency DOM updates.
import { keyInfo, startDisplay, launchChrome, newReporter, tmpProfile, rmProfile, sleep, xdo, findPage, realClick, clickToolbarIcon, shot, root, exportZip } from './lib.mjs';
import { startSites } from './site.mjs';
import { makeProbe } from './probe.mjs';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readFileSync as rf } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { unzipSync } from 'fflate';

const PORT = Number(process.env.RD_PORT ?? 9333), SITE = Number(process.env.RD_SITE ?? 4190), OTHER = SITE + 1;
const OUT = process.env.REAL_OUT || path.join(root, '../../real-results');
mkdirSync(OUT, { recursive: true });
const rep = newReporter();
const { ok, info } = rep;
const sites = await startSites(SITE, OTHER);
const disp = await startDisplay();
const ud = tmpProfile();
let chrome;

const colorCount = (file, rgb, tol = 28) => Number(execFileSync('python3', ['-c', `
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert('RGB'); w,h = im.size; px = im.load(); n = 0; tr,tg,tb = ${JSON.stringify(rgb)}
for y in range(0,h,2):
    for x in range(0,w,2):
        r,g,b = px[x,y]
        if abs(r-tr)<=${tol} and abs(g-tg)<=${tol} and abs(b-tb)<=${tol}: n += 1
print(n)`]).toString().trim());

// CPU / memory of the whole browser process tree (utime+stime from /proc, RSS in KB)
function tree(rootPid) {
  const rows = execFileSync('ps', ['-eo', 'pid,ppid']).toString().trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [pid, ppid] of rows) (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(pid);
  const out = [rootPid]; for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i]) ?? []));
  return out;
}
function usage(rootPid) {
  let ticks = 0, rss = 0;
  for (const pid of tree(rootPid)) {
    try {
      const st = rf(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ');
      ticks += Number(st[11]) + Number(st[12]);
      rss += Number(/VmRSS:\s+(\d+)/.exec(rf(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0);
    } catch { /* process gone */ }
  }
  return { ticks, rssMB: rss / 1024 };
}
async function measure(rootPid, ms) {
  const a = usage(rootPid); const t0 = Date.now(); await sleep(ms); const b = usage(rootPid);
  return { cores: (b.ticks - a.ticks) / 100 / ((Date.now() - t0) / 1000), rssMB: b.rssMB };
}

try {
  chrome = await launchChrome({ userData: ud, port: PORT, startUrl: `http://localhost:${SITE}/complex.html`, webgl: true });
  await sleep(4000);
  const probe = await makeProbe(PORT);
  await probe.setSettings({ replaySec: 60, tailSec: 1, preSessionSec: 0, fps: 15, bitrateKbps: 1500, openReviewAfterSave: false, afkMinutes: 0 });
  const page = await findPage(PORT, `http://localhost:${SITE}/complex.html`);
  const pid = chrome.proc.pid;

  const idle = await measure(pid, 10000);
  info('browser CPU, page NOT armed (cores)', idle.cores.toFixed(2));
  await clickToolbarIcon();
  ok('armed on the complex page', !!(await probe.until(async () => (await probe.state())?.mode === 'armed', 10000)));
  await sleep(3000);
  const armedUse = await measure(pid, 10000);
  info('browser CPU, armed and encoding VP9 (cores)', armedUse.cores.toFixed(2));
  info('capture overhead (cores)', (armedUse.cores - idle.cores).toFixed(2));
  info('browser tree RSS MB (armed)', armedUse.rssMB.toFixed(0));
  const h = await probe.health();
  info('encoder', `${h.codec} ${h.width}x${h.height}, frames in=${h.framesIn} encoded=${h.framesEncoded} dropped=${h.framesDropped}, written=${(h.bytesWritten / 1048576).toFixed(1)} MB`);
  ok('encoder keeps up on a heavy page (drop rate < 20%)', h.framesDropped / Math.max(1, h.framesEncoded + h.framesDropped) < 0.2, `dropped ${h.framesDropped}`);

  // ---- real interactions with every kind of content
  const rect = (sel) => page.eval(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, sx: window.screenX, sy: window.screenY + window.outerHeight - window.innerHeight - 4 }; })()`);
  const clickAt = async (sel, fx, fy) => { const r = await rect(sel); xdo('mousemove', String(Math.round(r.sx + 4 + r.x + r.w * fx)), String(Math.round(r.sy + r.y + r.h * fy))); await sleep(150); xdo('click', '1'); await sleep(300); };
  await clickAt('#gl', 0.5, 0.5);                 // click inside WebGL canvas
  await clickAt('#chart', 0.4, 0.5);              // click inside 2D canvas
  await clickAt('#same', 0.12, 0.7);              // button inside same-origin iframe
  await clickAt('#cross', 0.12, 0.7);             // button inside cross-origin iframe
  await clickAt('#host', 0.5, 0.5);               // Shadow DOM button
  for (let i = 0; i < 6; i++) { const r = await rect('#grid'); xdo('mousemove', String(Math.round(r.sx + 4 + r.x + r.w / 2)), String(Math.round(r.sy + r.y + r.h / 2))); xdo('click', '5'); await sleep(250); } // scroll grid
  await clickAt('#grid', 0.4, 0.3);               // click a virtualised row
  await sleep(4000);
  const evs = (await probe.dump('events')).filter((e) => e.sessionId === 'ring' && e.type === 'click');
  const describe = (e) => `${e.element?.tag}:${e.element?.role ?? '-'}:${e.element?.label ?? '-'}`;
  info('semantic click events recorded', evs.map(describe).join(' | '));
  const has = (re) => evs.some((e) => re.test(describe(e)));
  ok('DOM semantics: canvas click is seen (element only - the drawn content is invisible to the DOM)', has(/^canvas/));
  ok('DOM semantics: Shadow DOM action is seen with its label', has(/Shadow action/));
  ok('DOM semantics: virtualised grid row is seen (order number redacted)', has(/Row \d+ - Order #\[redacted\]/));
  ok('DOM semantics: same-origin iframe button is seen', has(/Inner button/) && evs.some((e) => e.frame));
  const all = await probe.dump('events');
  ok('cross-origin (unapproved) iframe events are NOT stored - its pixels are in the video, its semantics are out of scope by policy', !all.some((e) => (e.origin ?? '').includes(':' + OTHER)));
  shot(path.join(OUT, '30-complex-page.png'));

  // ---- the pixel video must show all of it
  await sleep(2000);
  await (await findPage(PORT, 'chrome-extension://' + keyInfo.id + '/sidepanel.html')).eval(`document.querySelector('[data-c="saveReplay"]').click()`);
  const inst = await probe.until(async () => (await probe.dump('sessions')).find((s) => s.kind === 'instant' && s.status === 'finished'), 20000);
  ok('replay of the complex page saved', !!inst);
  const zipPath = inst && (await exportZip(PORT, inst.id, path.join(OUT, 'dl-complex')));
  ok('exported through the real Review page', !!zipPath);
  if (zipPath) {
    const z = unzipSync(new Uint8Array(readFileSync(zipPath)));
    const webm = path.join(OUT, 'complex.webm');
    writeFileSync(webm, z['replay.webm']);
    const dur = Number(/duration=([\d.]+)/.exec(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1', webm]).toString())?.[1] ?? 0);
    info('replay duration (s)', dur.toFixed(1));
    const want = { 'WebGL clear colour (teal)': [0, 200, 200], 'WebGL spinning quad (yellow)': [255, 255, 0], '2D canvas chart (green)': [0, 170, 0], 'same-origin iframe content (orange)': [255, 140, 0], 'cross-origin iframe content (purple)': [128, 0, 200] };
    const seen = Object.fromEntries(Object.keys(want).map((k) => [k, 0]));
    for (const t of [dur * 0.25, dur * 0.5, dur * 0.75].map((x) => Math.max(0.5, x))) {
      const frame = path.join(OUT, `complex-frame-${t.toFixed(1)}.png`);
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', webm, '-frames:v', '1', frame]);
      for (const [k, rgb] of Object.entries(want)) seen[k] = Math.max(seen[k], colorCount(frame, rgb));
    }
    for (const [k, n] of Object.entries(seen)) ok(`pixel video preserves: ${k}`, n > 150, `matching samples=${n}`);
    const mux = z['manifest.json'] && JSON.parse(Buffer.from(z['manifest.json']).toString()).video;
    info('video in manifest', JSON.stringify(mux));
  }
} catch (e) {
  console.error('real-complex aborted:', e instanceof Error ? e.stack : e);
  ok('suite completed without an exception', false, String(e));
} finally {
  await chrome?.close();
  disp.stop();
  sites.close();
  rmProfile(ud);
  process.exit(rep.summary() ? 1 : 0);
}
