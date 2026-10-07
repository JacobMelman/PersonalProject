// Real-browser Screenshot-only mode (video OFF): the capture path that needs a genuine activeTab user gesture.
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
  await probe.setSettings({ captureVideo: false, openReviewAfterSave: false, markerScreenshot: true });
  const page = await findPage(PORT, `http://localhost:${SITE}/`);
  await clickToolbarIcon();
  const st = await probe.until(async () => { const s = await probe.state(); return s?.mode === 'screenshot_only' ? s : null; }, 10000);
  ok('video OFF: real click arms Screenshot-only mode', !!st);
  await sleep(1500);
  const panel = await findPage(PORT, 'chrome-extension://' + keyInfo.id + '/sidepanel.html');
  ok('no capture document / encoder exists in Screenshot-only mode', !(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).some((t) => t.url.endsWith('offscreen.html')));
  ok('status text says SCREENSHOTS ONLY / VIDEO OFF', /SCREENSHOTS ONLY/.test(await panel.eval(`document.body.innerText`)));
  await realClick(page, '#add');
  await panel.eval(`document.querySelector('[data-c="screenshot"]').click()`);
  const s1 = await probe.until(async () => (await probe.dump('shots'))[0], 8000);
  ok('Screenshot button captures the approved tab (captureVisibleTab with the activeTab from the toolbar click)', !!s1);
  if (s1) {
    ok('screenshot carries metadata: origin/path, browser, viewport, mode', s1.origin === `http://localhost:${SITE}` && s1.path === '/' && /Chrome /.test(s1.browser) && !!s1.viewport && s1.captureMode === 'screenshot_only', JSON.stringify({ o: s1.origin, p: s1.path, b: s1.browser, v: s1.viewport }));
    ok('timeline context around the screenshot is attached (nearby safe events)', (await probe.dump('events')).some((e) => e.sessionId === s1.sessionId && e.type === 'click'));
  }
  await realClick(page, '#nav-profile');
  xdo('key', 'alt+shift+s');
  const s2 = await probe.until(async () => ((await probe.dump('shots')).length >= 2 ? true : null), 8000);
  ok('Alt+Shift+S shortcut also captures', !!s2);
  info('screenshots after two captures', (await probe.dump('shots')).length);

  // fail closed on a foreign origin: nothing captured, honest message
  const n0 = (await probe.dump('shots')).length;
  await page.eval(`location.assign('http://localhost:${OTHER}/')`);
  await sleep(4500);
  await panel.eval(`document.querySelector('[data-c="screenshot"]').click()`);
  await sleep(2500);
  ok('screenshot of an unapproved origin is refused (fail closed)', (await probe.dump('shots')).length === n0);
  const note = await probe.session('notice');
  ok('the refusal is explicit to the user', /not captured|not the active/i.test(note?.text ?? ''), note?.text ?? '');
  ok('refusal is recorded as a system event, not a fake screenshot', (await probe.dump('events')).some((e) => /Screenshot not captured/.test(e.label ?? '')));
  shot(path.join(OUT, '20-screenshot-only-foreign.png'));

  await page.eval(`location.assign('http://localhost:${SITE}/')`);
  await sleep(2500);
  await clickToolbarIcon();
  await sleep(2000);
  await panel.eval(`document.querySelector('[data-c="finishShotSession"]') && document.querySelector('[data-c="finishShotSession"]').click()`);
  const fin = await probe.until(async () => (await probe.dump('sessions')).find((s) => s.kind === 'screenshot' && s.status === 'finished'), 8000);
  ok('screenshot collection finishes as a reviewable session', !!fin);
} catch (e) {
  console.error('real-screenshot aborted:', e instanceof Error ? e.stack : e);
  ok('suite completed without an exception', false, String(e));
} finally {
  await chrome?.close();
  disp.stop();
  sites.close();
  rmProfile(ud);
  process.exit(rep.summary() ? 1 : 0);
}
