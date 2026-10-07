// B0.14 / B0.19 in real Chromium: a popup/new tab opened by the tested app is never captured silently;
// a genuine toolbar click on it moves the Active Video Target (user-gesture re-arm).
import { keyInfo, startDisplay, launchChrome, newReporter, tmpProfile, rmProfile, sleep, findPage, realClick, clickToolbarIcon, shot, root } from './lib.mjs';
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
  await probe.setSettings({ replaySec: 30, tailSec: 1, preSessionSec: 0, fps: 10, afkMinutes: 0, openReviewAfterSave: false });
  const page = await findPage(PORT, `http://localhost:${SITE}/`);
  await clickToolbarIcon();
  const armed = await probe.until(async () => { const s = await probe.state(); return s?.mode === 'armed' ? s : null; }, 10000);
  ok('armed on the main tab', !!armed);
  await sleep(2000);
  await realClick(page, '#popup'); // the app opens a popup (window.open from a user gesture)
  const paused = await probe.until(async () => (await probe.state()).privacy, 8000);
  ok('popup opened by the app: capture pauses, the popup is NOT silently captured', !!paused);
  await sleep(1500);
  const popupTarget = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.endsWith('/popup.html'));
  ok('the popup tab exists and is the active tab', !!popupTarget);
  const ev0 = (await probe.dump('events')).length;
  shot(path.join(OUT, '50-popup-paused.png'));
  await clickToolbarIcon(); // genuine user gesture on the popup tab
  const switched = await probe.until(async () => { const s = await probe.state(); return s && s.targetTabId !== armed.targetTabId && !s.privacy ? s : null; }, 8000);
  ok('a real toolbar click on the popup moves the Active Video Target there and resumes', !!switched);
  ok('the switch is a visible timeline event', (await probe.dump('events')).some((e) => /Active Video Target switched/.test(e.label ?? '')));
  const pop = await findPage(PORT, `http://localhost:${SITE}/popup.html`);
  await realClick(pop, '#pb');
  await sleep(1500);
  ok('actions in the popup are recorded after the switch', (await probe.dump('events')).slice(ev0).some((e) => e.type === 'click' && e.element?.label === 'Popup button'));
  const h = await probe.until(async () => { const x = await probe.health(); return x && !x.paused && Date.now() - x.at < 3000 ? x : null; }, 6000);
  ok('video capture continues on the new target', !!h);
  shot(path.join(OUT, '51-popup-switched.png'));
} catch (e) {
  console.error('real-popup aborted:', e instanceof Error ? e.stack : e);
  ok('suite completed without an exception', false, String(e));
} finally {
  await chrome?.close();
  disp.stop();
  sites.close();
  rmProfile(ud);
  process.exit(rep.summary() ? 1 : 0);
}
