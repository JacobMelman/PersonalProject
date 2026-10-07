// Real-browser lifecycle checks: genuine X11 idle (AFK), Chrome-initiated service-worker recycling,
// an OS-level window drawn over the browser (must never appear in the recording), activeTab behaviour on navigation, Screenshot-only.
import { openBackgroundPage, keyInfo, startDisplay, launchChrome, newReporter, tmpProfile, rmProfile, sleep, xdo, findPage, realClick, clickToolbarIcon, shot, root, exportZip } from './lib.mjs';
import { startSites } from './site.mjs';
import { makeProbe } from './probe.mjs';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
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
let ph;
const nonWhite = (file) => Number(execFileSync('python3', ['-c', `
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert('RGB'); w,h = im.size; px = im.load(); n = 0
for y in range(0,h,4):
    for x in range(0,w,4):
        r,g,b = px[x,y]
        if r<235 or g<235 or b<235: n += 1
print(n)`]).toString().trim());
const redPixels = (file) => Number(execFileSync('python3', ['-c', `
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert('RGB'); w,h = im.size; px = im.load(); n = 0
for y in range(0,h,2):
    for x in range(0,w,2):
        r,g,b = px[x,y]
        if r>240 and g<14 and b<14: n += 1
print(n)`]).toString().trim());
try {
  chrome = await launchChrome({ userData: ud, port: PORT, startUrl: `http://localhost:${SITE}/` });
  await sleep(3000);
  const probe = await makeProbe(PORT);
  await probe.setSettings({ replaySec: 30, tailSec: 1, preSessionSec: 0, fps: 10, bitrateKbps: 1000, openReviewAfterSave: false, afkMinutes: 5 });
  const page = await findPage(PORT, `http://localhost:${SITE}/`);
  await clickToolbarIcon();
  ok('armed by a real click', !!(await probe.until(async () => (await probe.state())?.mode === 'armed', 10000)));
  const panel = await findPage(PORT, 'chrome-extension://' + keyInfo.id + '/sidepanel.html');
  shot(path.join(OUT, '10-armed-panel.png'));

  // ------------------------------------------------ REAL AFK: X11 idle time -> chrome.idle -> AFK
  await probe.p.eval(`chrome.idle.setDetectionInterval(15)`); // shortest interval Chrome allows; the production default is 10 min
  const idleStart = Date.now();
  const afk = await probe.until(async () => (await probe.state())?.afk === true, 60000, 1000);
  ok('REAL idle (no input) puts the session into AFK via chrome.idle', !!afk, afk ? `after ${Math.round((Date.now() - idleStart) / 1000)}s` : 'never');
  await sleep(2500);
  const h1 = await probe.health(); await sleep(3000); const h2 = await probe.health();
  ok('encoder is suspended while AFK (no new frames)', h2.paused === true && h2.framesEncoded - h1.framesEncoded <= 1, `delta=${h2.framesEncoded - h1.framesEncoded}`);
  xdo('mousemove_relative', '--', '30', '30'); // real input = user is back
  const back = await probe.until(async () => { const s = await probe.state(); return s && !s.afk ? s : null; }, 25000, 500);
  ok('REAL activity returns from AFK and Armed resumes automatically', !!back && back.mode === 'armed');
  const h3 = await probe.until(async () => { const h = await probe.health(); return h && !h.paused ? h : null; }, 8000);
  ok('encoder resumes after AFK', !!h3);

  // ------------------------------------------------ OS-level window over the browser must never be recorded
  const term = spawn('xterm', ['-bg', '#ff0000', '-fg', 'white', '-geometry', '90x28+80+180', '-e', 'sleep 120'], { env: { ...process.env, DISPLAY: process.env.RD_DISPLAY || ':99' }, stdio: 'ignore' });
  await sleep(2500);
  shot(path.join(OUT, '11-os-window-over-browser.png'));
  const control = redPixels(path.join(OUT, '11-os-window-over-browser.png'));
  ok('control: the red OS window really covers part of the screen', control > 5000, `red samples=${control}`);
  await sleep(3000);
  await panel.eval(`document.querySelector('[data-c="saveReplay"]').click()`);
  const inst = await probe.until(async () => (await probe.dump('sessions')).find((s) => s.kind === 'instant' && s.status === 'finished'), 15000);
  term.kill();
  ok('replay saved while the OS window was on screen', !!inst);
  const zipPath = inst && (await exportZip(PORT, inst.id, path.join(OUT, 'dl')));
  ok('Evidence Package exported through the real Review page', !!zipPath);
  if (zipPath) {
    const z = unzipSync(new Uint8Array(readFileSync(zipPath)));
    const webm = path.join(OUT, 'replay-overlay.webm');
    writeFileSync(webm, z['replay.webm']);
    const dur = Number(/duration=([\d.]+)/.exec(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1', webm]).toString())?.[1] ?? 0);
    let worstRed = 0, content = 0;
    for (const t of [1, Math.max(1.5, dur / 2), Math.max(2, dur - 1.5)]) {
      const frame = path.join(OUT, `overlay-frame-${t.toFixed(1)}.png`);
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', webm, '-frames:v', '1', frame]);
      worstRed = Math.max(worstRed, redPixels(frame));
      content = Math.max(content, nonWhite(frame));
    }
    ok('recorded video is real (long enough, shows the page)', dur > 4 && content > 200, `video ${dur.toFixed(1)}s, page-content samples=${content}`);
    ok('the OS window drawn over the browser is absent from the recorded video', worstRed < 200, `red samples in recorded frames=${worstRed}`);
  }

  // ------------------------------------------------ navigation behaviour with activeTab only (no host permission)
  const evCount = async () => (await probe.dump('events')).length;
  await page.eval(`location.assign('/popup.html')`);
  await sleep(4500);
  let st = await probe.state();
  info('same-origin full-page navigation: activeTab kept the page collectable (not paused)', !st.privacy);
  const e0 = await evCount();
  await realClick(page, '#pb');
  await sleep(1500);
  const gained = (await evCount()) - e0;
  ok('never fail-open: if capture is not paused after a navigation, the new page IS being collected', st.privacy || gained >= 1, `privacy=${st.privacy} events+${gained}`);
  await page.eval(`location.assign('http://localhost:${OTHER}/')`); // same site (bfcache candidate), different origin
  const crossPaused = await probe.until(async () => (await probe.state()).privacy, 6000, 250);
  ok('navigating to another origin pauses capture (bfcache-safe)', !!crossPaused);
  await sleep(1500);
  ok('no events stored for the foreign origin', !(await probe.dump('events')).some((e) => (e.origin ?? '').includes(':' + OTHER)));
  shot(path.join(OUT, '12-foreign-origin-paused.png'));

  // ------------------------------------------------ REAL service-worker termination: stopped from chrome://serviceworker-internals
  // (no debugger is attached to the worker in this harness, so Chrome really terminates it; the next event starts a fresh one)
  const starts0 = await probe.session('swStarts');
  info('service-worker starts before stop', starts0);
  const swi = await openBackgroundPage(PORT, 'chrome://serviceworker-internals/');
  await sleep(1500);
  const stopped = await swi.eval(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Stop'); if (!b) return false; b.click(); return true; })()`, { gesture: true });
  swi.close();
  ok('Stop pressed on the extension service worker in chrome://serviceworker-internals', !!stopped);
  const t0 = Date.now();
  const recycled = await probe.until(async () => (await probe.session('swStarts')) > starts0, 100000, 2000);
  ok('a fresh service worker was started by Chrome after the termination', !!recycled, recycled ? `after ${Math.round((Date.now() - t0) / 1000)}s, starts=${await probe.session('swStarts')}` : 'not restarted within 100 s');
  const mid = await probe.state();
  ok('state survived the recycle (still armed, still paused, target kept)', mid.mode === 'armed' && mid.privacy === true && !mid.terminal);
  ph = await probe.health();
  ok('capture pipeline kept running in the offscreen document', ph && Date.now() - ph.at < 4000);
  await page.eval(`location.assign('http://localhost:${SITE}/')`);
  await sleep(2500);
  info('back on the approved origin, activeTab lost -> paused until the icon is clicked again', (await probe.state()).privacy);
  await clickToolbarIcon(); // re-grant activeTab + re-validate (the icon sits further left while the side panel is open)
  const resumed = await probe.until(async () => !(await probe.state()).privacy, 8000, 300);
  shot(path.join(OUT, '13-after-reclick.png'));
  info('notice after re-click', JSON.stringify(await probe.session('notice')));
  ok('clicking the icon on the approved page resumes collection after the foreign detour', !!resumed);
  await sleep(1500);
  await realClick(page, '#add');
  await sleep(2000);
  shot(path.join(OUT, '14-after-click-add.png'));
  info('state after click', JSON.stringify(await probe.state()));
  const lateEv = (await probe.dump('events')).filter((e) => e.type === 'click' && e.ts > Date.now() - 6000);
  ok('events flow through the restarted service worker', lateEv.length >= 1);
} catch (e) {
  console.error('real-lifecycle aborted:', e instanceof Error ? e.stack : e);
  ok('suite completed without an exception', false, String(e));
} finally {
  await chrome?.close();
  disp.stop();
  sites.close();
  rmProfile(ud);
  process.exit(rep.summary() ? 1 : 0);
}
