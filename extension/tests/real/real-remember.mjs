// "Remember this site": the genuine Chrome permission prompt, persistent content-script registration, and what it buys
// (collection survives full-page navigations and foreign detours without clicking the icon again).
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
  await probe.setSettings({ replaySec: 30, tailSec: 1, preSessionSec: 0, fps: 10, afkMinutes: 0, openReviewAfterSave: false });
  const page = await findPage(PORT, `http://localhost:${SITE}/`);
  await clickToolbarIcon();
  ok('armed', !!(await probe.until(async () => (await probe.state())?.mode === 'armed', 10000)));
  await sleep(1500);
  // genuine click on "Remember this site" in the side panel -> Chrome's own permission bubble
  xdo('mousemove', '1308', '385'); await sleep(200); xdo('click', '1'); await sleep(1500);
  shot(path.join(OUT, '40-permission-prompt.png'));
  xdo('mousemove', '676', '260'); await sleep(200); xdo('click', '1'); // Allow
  const granted = await probe.until(async () => (await probe.p.eval(`chrome.permissions.getAll().then((p) => p.origins)`)).some((o) => o.includes(`localhost:${SITE}`)), 6000);
  ok('Chrome permission prompt shown and host access granted for exactly this origin', !!granted, JSON.stringify(await probe.p.eval(`chrome.permissions.getAll().then((p) => p.origins)`)));
  await sleep(1500);
  const reg = await probe.p.eval(`chrome.scripting.getRegisteredContentScripts().then((r) => r.map((x) => ({ id: x.id, matches: x.matches, allFrames: x.allFrames, persist: x.persistAcrossSessions })))`);
  ok('a persistent content script is registered only for that origin', reg.length === 1 && reg[0].matches[0] === `http://localhost:${SITE}/*` && reg[0].persist === true, JSON.stringify(reg));
  const settings = await probe.p.eval(`chrome.storage.local.get('settings').then((r) => r.settings)`);
  ok('origin added to the Target Profile approved origins', settings.approvedOrigins.includes(`http://localhost:${SITE}`));

  // full-page navigation: no icon click needed any more
  await page.eval(`location.assign('/popup.html')`);
  await sleep(3500);
  ok('after a full-page navigation collection continues by itself', (await probe.state()).privacy === false);
  const e0 = (await probe.dump('events')).length;
  await realClick(page, '#pb');
  await sleep(1500);
  ok('new document is collected (click recorded)', (await probe.dump('events')).length > e0);

  // foreign detour (different origin, not remembered): paused; coming back resumes WITHOUT clicking the icon
  await page.eval(`location.assign('http://localhost:${OTHER}/')`);
  ok('foreign origin pauses capture', !!(await probe.until(async () => (await probe.state()).privacy, 6000)));
  await page.eval(`location.assign('http://localhost:${SITE}/')`);
  const back = await probe.until(async () => !(await probe.state()).privacy, 8000, 300);
  ok('returning to the remembered origin resumes automatically (no icon click needed)', !!back);
  await realClick(page, '#add');
  await sleep(1500);
  ok('events flow again after the detour', (await probe.dump('events')).some((e) => e.type === 'click' && e.element?.label === 'Add to cart' && e.ts > Date.now() - 6000));
  ok('no events were stored for the foreign origin', !(await probe.dump('events')).some((e) => (e.origin ?? '').includes(':' + OTHER)));
  shot(path.join(OUT, '41-remembered.png'));
} catch (e) {
  console.error('real-remember aborted:', e instanceof Error ? e.stack : e);
  ok('suite completed without an exception', false, String(e));
} finally {
  await chrome?.close();
  disp.stop();
  sites.close();
  rmProfile(ud);
  process.exit(rep.summary() ? 1 : 0);
}
