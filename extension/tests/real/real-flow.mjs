// Real-browser validation: genuine toolbar click (activeTab), genuine keyboard shortcuts, genuine mouse/keyboard input.
// Run:  xvfb is started by the script itself.   node tests/real/real-flow.mjs
import { keyInfo, startDisplay, launchChrome, newReporter, tmpProfile, rmProfile, sleep, xdo, findPage, realClick, clickToolbarIcon, shot, root } from './lib.mjs';
import { startSites } from './site.mjs';
import { makeProbe } from './probe.mjs';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const PORT = Number(process.env.RD_PORT ?? 9333), SITE = Number(process.env.RD_SITE ?? 4190), OTHER = SITE + 1;
const OUT = process.env.REAL_OUT || path.join(root, '../../real-results');
mkdirSync(OUT, { recursive: true });
const rep = newReporter();
const { ok, info } = rep;
const sites = await startSites(SITE, OTHER);
const disp = await startDisplay();
const ud = tmpProfile();
let chrome;
try {
  chrome = await launchChrome({ userData: ud, port: PORT, startUrl: `http://localhost:${SITE}/` });
  await sleep(3000);
  const probe = await makeProbe(PORT);
  await probe.setSettings({ replaySec: 30, tailSec: 1, preSessionSec: 30, fps: 10, bitrateKbps: 1000, openReviewAfterSave: false, afkMinutes: 5 });
  const page = await findPage(PORT, `http://localhost:${SITE}/`);

  // ---- real toolbar click arms the extension (activeTab granted by Chrome itself, no test flags)
  await clickToolbarIcon();
  const armed = await probe.until(async () => { const s = await probe.state(); return s?.mode === 'armed' ? s : null; }, 10000);
  ok('REAL toolbar click arms ReproDesk (activeTab + tabCapture, no allow-list flag)', !!armed);
  ok('badge shows ON', (await probe.badge()) === 'ON');
  ok('side panel opened by the click', (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).some((t) => t.url.endsWith('/sidepanel.html')));
  const h = await probe.until(async () => { const x = await probe.health(); return x && x.segmentsWritten > 0 ? x : null; }, 15000);
  ok('encoder writes segments on real Chromium', !!h, h ? `${h.codec} ${h.width}x${h.height}` : '');
  shot(path.join(OUT, '01-armed.png'));

  // ---- real mouse + real keyboard input
  await realClick(page, '#add');
  await realClick(page, '#nav-profile');
  await realClick(page, '#user');
  xdo('type', '--delay', '40', 'real.typed.username');
  await realClick(page, '#pw');
  xdo('type', '--delay', '40', 'RealTypedSecret99');
  await realClick(page, '#save');
  await sleep(1200);
  const evs = await probe.dump('events');
  const dumpStr = JSON.stringify(evs);
  ok('real clicks recorded with button label', evs.some((e) => e.type === 'click' && e.element?.label === 'Add to cart'));
  ok('real keystrokes are never stored (no keylogging)', !/RealTypedSecret99|real\.typed\.username/.test(dumpStr) && !evs.some((e) => e.type === 'key'));
  ok('no query/fragment stored', !/SECRETQUERY|#frag/.test(dumpStr));

  // ---- real keyboard shortcuts (chrome.commands)
  const cmds = await probe.commands();
  ok('three default shortcuts are registered (Chrome allows 3 suggested keys + the action)', cmds.filter((c) => c.shortcut).length === 3, cmds.map((c) => `${c.name}=${c.shortcut || '-'}`).join(' '));
  await realClick(page, '#nav-home');
  const panel = await findPage(PORT, 'chrome-extension://' + keyInfo.id + '/sidepanel.html');
  await panel.eval(`document.querySelector('[data-c="startRepro"]').click()`);
  const repro = await probe.until(async () => { const s = await probe.state(); return s?.mode === 'repro' ? s : null; }, 6000);
  ok('Start Repro Session from the side panel', !!repro);
  await realClick(page, '#nav-cart');
  await realClick(page, '#nav-home');
  await sleep(500);
  xdo('key', 'alt+shift+m');
  await sleep(2500);
  xdo('key', 'alt+shift+s');
  await sleep(2500);
  const evs2 = await probe.dump('events');
  ok('Alt+Shift+M adds a marker', evs2.some((e) => e.type === 'marker' && e.sessionId === repro?.sessionId));
  const shots = (await probe.dump('shots')).filter((s) => s.sessionId === repro?.sessionId);
  ok('Alt+Shift+S and the marker produce screenshots', shots.length >= 2, `shots=${shots.length}`);
  await panel.eval(`document.querySelector('[data-c="finishRepro"]').click()`);
  const fin = await probe.until(async () => { const s = (await probe.dump('sessions')).find((x) => x.id === repro?.sessionId); return s?.status === 'finished' ? s : null; }, 8000);
  ok('Finish from the side panel ends the session', !!fin);
  ok('Pre-session Context was captured from the real ring', !!fin?.preContext, fin?.preContext ? `${Math.round((fin.preContext.endWall - fin.preContext.startWall) / 1000)}s` : 'none');
  await sleep(1500);
  xdo('key', 'alt+shift+r');
  const inst = await probe.until(async () => (await probe.dump('sessions')).find((s) => s.kind === 'instant' && s.status === 'finished'), 12000);
  ok('Alt+Shift+R saves the last replay', !!inst);
  shot(path.join(OUT, '02-after-shortcuts.png'));
} catch (e) {
  console.error('real-flow aborted:', e instanceof Error ? e.stack : e);
  ok('suite completed without an exception', false, String(e));
} finally {
  await chrome?.close();
  disp.stop();
  sites.close();
  rmProfile(ud);
  process.exit(rep.summary() ? 1 : 0);
}
