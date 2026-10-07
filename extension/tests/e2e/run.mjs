// End-to-end spike checks against a local fixture site, using the E2E build of the extension in real Chromium.
// Run: npm run test:e2e   (headless "new" mode; on a machine with a display you can set HEADED=1)
import { launch, keyInfo, newReporter, rmProfile, sleep, startSite, tmpProfile } from './lib.mjs';

const PORT = 4173;
const only = process.argv.slice(2);
const server = await startSite(PORT);
const rep = newReporter();
const ok = rep.ok;
const wanted = (n) => !only.length || only.includes(n);
const userData = tmpProfile();
const { ctx, rd, state, setSettings, health, dump, until, activeTabId } = await launch(userData);
const tabIdOf = () => activeTabId();
let failed = 0;
void failed;

try {
  await setSettings({ replaySec: 30, tailSec: 0, preSessionSec: 30, openReviewAfterSave: false, markerScreenshot: true, afkMinutes: 10, fps: 10, bitrateKbps: 1000 });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`);
  await page.bringToFront();
  const tabId = await tabIdOf();
  ok('fixture tab found', tabId != null);

  // ------------------------------------------------------------------ arm + capture health (B0.1, B0.2)
  await rd((id) => self.__rd.armTab(id), tabId);
  let st = await state();
  ok('ARM -> armed (or error is reported honestly)', st.mode === 'armed', `mode=${st.mode} terminal=${st.terminal} reason=${st.reason ?? ''}`);
  if (st.terminal) { console.log('capture could not start; aborting remaining checks'); throw new Error('capture failed: ' + st.reason); }
  const h1 = await until(async () => { const h = await health(); return h && h.segmentsWritten > 0 ? h : null; }, 20000);
  ok('encoder produces stored GOP segments', !!h1, h1 ? `codec=${h1.codec} ${h1.width}x${h1.height} segs=${h1.segmentsWritten} frames=${h1.framesEncoded}` : 'no health');

  // ------------------------------------------------------------------ semantic privacy (B0.5)
  await page.click('#add');
  await page.click('#nav-profile');
  await page.fill('#user', 'jane.secret.user');
  await page.fill('#pw', 'Hunter2-SECRETPASSWORD');
  await page.fill('#note', 'TOPSECRETNOTE-123456');
  await page.click('#save');
  await page.click('#nav-cart');
  await sleep(1500);
  const allEvs = await dump('events');
  const evs = allEvs.filter((e) => e.sessionId === 'ring');
  const blob = JSON.stringify(allEvs);
  ok('clicks and navigation are recorded', evs.some((e) => e.type === 'click' && e.element?.label === 'Add to cart') && evs.some((e) => e.type === 'navigate' && e.path === '/cart'), `events=${evs.length}`);
  ok('no typed/editable values or key content persisted', !/Hunter2|SECRETPASSWORD|jane\.secret|TOPSECRETNOTE/.test(blob));
  ok('no query string or fragment persisted', !/SECRETQUERY|#frag|token=/.test(blob));
  ok('PII-looking text is redacted from labels', !/jane\.doe@bank|4111/.test(blob));
  ok('events carry origin+path only (no editable element text)', evs.filter((e) => e.element && ['textbox'].includes(e.element.role)).every((e) => e.element.label === null || e.element.label.length < 30));

  // ------------------------------------------------------------------ Save Last Replay + playback (B0.2/B0.4/B0.9)
  if (wanted('replay') || !only.length) {
    await sleep(3000);
    await setSettings({ tailSec: 2 });
    const tTrigger = Date.now();
    await rd(() => self.__rd.saveReplay());
    const sessions = await until(async () => { const s = await dump('sessions'); return s.find((x) => x.kind === 'instant' && x.status === 'finished') ? s : null; }, 15000);
    const inst = sessions?.find((x) => x.kind === 'instant');
    ok('Save Last Replay creates a finished instant session', !!inst);
    ok('post-trigger tail is included in the saved window', !!inst && inst.endedAt >= tTrigger + 1500, inst ? `end-trigger=${inst.endedAt - tTrigger}ms` : '');
    await setSettings({ tailSec: 0 });
    const segs = await dump('segments');
    ok('replay segments are pinned to the session (not copied)', segs.some((s) => s.refs.includes(inst?.id)));
    const rv = await ctx.newPage();
    await rv.goto(`chrome-extension://${keyInfo.id}/review.html?session=${inst.id}`);
    const vinfo = await until(async () => rv.evaluate(() => { const v = document.getElementById('vid'); return v && v.readyState >= 1 && v.duration > 0 ? { w: v.videoWidth, h: v.videoHeight, d: v.duration } : null; }), 15000);
    ok('muxed WebM replay decodes and plays in the Review page', !!vinfo && vinfo.w > 0, vinfo ? `${vinfo.w}x${vinfo.h} ${vinfo.d.toFixed(1)}s` : 'no video');
    ok('replay is bounded by the configured window (30s +GOP slack)', vinfo && vinfo.d <= 36, vinfo ? `duration ${vinfo.d.toFixed(1)}s` : '');
    const txt = await rv.evaluate(() => document.body.innerText);
    ok('Review lists draft steps from observed actions', /Click button "Add to cart"/.test(txt));
    ok('Review shows the visual sensitive-data warning', /Values visible in the tested application/.test(txt));
    await rv.close();
    await page.bringToFront();
    await rd(() => self.__rd.reevaluate());
  }

  // ------------------------------------------------------------------ Repro Session, markers, privacy pause (B0.3, B0.7, B0.20)
  await sleep(1000);
  await rd(() => self.__rd.startRepro());
  st = await state();
  ok('Repro Session starts', st.mode === 'repro' && !!st.sessionId);
  const reproId = st.sessionId;
  await page.click('#nav-home');
  await rd(() => self.__rd.marker('Extra button'));
  await sleep(2500);
  const other = await ctx.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  const paused = await until(async () => (await state()).privacy, 5000);
  ok('switching tabs enters Privacy Pause', !!paused);
  await page.bringToFront();
  const resumed = await until(async () => !(await state()).privacy, 8000);
  ok('returning to the approved tab auto-resumes', !!resumed);
  await other.close();
  // navigate the same tab to a different origin -> must fail closed
  await page.goto(`http://127.0.0.1:${PORT}/profile`);
  const crossPaused = await until(async () => (await state()).privacy, 8000);
  ok('navigating the target tab to an unapproved origin pauses capture (fail closed)', !!crossPaused);
  await sleep(1000);
  const foreign = (await dump('events')).filter((e) => (e.origin ?? '').includes('127.0.0.1'));
  ok('no events stored for the unapproved origin', foreign.length === 0, `foreign events=${foreign.length}`);
  await page.goto(`http://localhost:${PORT}/`);
  await until(async () => !(await state()).privacy, 8000);
  await sleep(1200);
  await rd(() => self.__rd.screenshot());
  await sleep(2500);
  await rd(() => self.__rd.finishRepro());
  const sess = (await dump('sessions')).find((s) => s.id === reproId);
  ok('Repro Session finished and returned to Armed', sess?.status === 'finished' && (await state()).mode === 'armed');
  ok('Pre-session Context recorded separately', !!sess?.preContext, sess?.preContext ? `${Math.round((sess.preContext.endWall - sess.preContext.startWall) / 1000)}s` : 'none (ring was empty)');
  const shots = (await dump('shots')).filter((s) => s.sessionId === reproId);
  ok('marker + manual screenshots stored as evidence items', shots.length >= 2, `shots=${shots.length}`);
  const sevs = (await dump('events')).filter((e) => e.sessionId === reproId);
  ok('timeline has user marker and system markers', sevs.some((e) => e.type === 'marker' && e.label === 'Extra button') && sevs.some((e) => e.type === 'system'));

  // ------------------------------------------------------------------ AFK (B0.21)
  await rd(() => self.__rd.dispatch({ type: 'AFK_ENTER' }));
  await sleep(1500);
  const a1 = await health();
  await sleep(3500);
  const a2 = await health();
  ok('AFK suspends the encoder (no new chunks while AFK)', a2.paused === true && a2.framesEncoded - a1.framesEncoded <= 1, `delta=${a2.framesEncoded - a1.framesEncoded}`);
  await rd(() => self.__rd.dispatch({ type: 'AFK_EXIT' }));
  const back = await until(async () => { const s = await state(); const h = await health(); return !s.afk && h && h.paused === false; }, 6000);
  ok('Armed resumes automatically after AFK', !!back);

  // ------------------------------------------------------------------ ring boundedness (CAP-01 / CAP-14), ~35s
  await sleep(Math.max(0, 40000 - (Date.now() - (h1?.at ?? Date.now()))));
  const ring = (await dump('segments')).filter((s) => s.refs.length === 0);
  const oldest = Math.min(...ring.map((s) => s.endWall));
  ok('temporary ring only holds the recent window (aged chunks expire)', ring.length > 0 && Date.now() - oldest < (30 + 15) * 1000, `oldest age ${((Date.now() - oldest) / 1000).toFixed(0)}s, ring segments ${ring.length}`);

  // ------------------------------------------------------------------ popup / Active Video Target switch (B0.14, B0.19)
  const mainId = (await state()).targetTabId;
  const popupPromise = ctx.waitForEvent('page');
  await page.click('#popup');
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await popup.bringToFront();
  const popupNotActive = await until(async () => (await state()).privacy, 5000);
  ok('a new tab/popup is never silently captured (Privacy Pause until the user re-arms there)', !!popupNotActive);
  const popupId = await activeTabId();
  await rd((id) => self.__rd.armTab(id), popupId);
  st = await state();
  ok('explicit re-arm moves the Active Video Target to the approved popup', st.targetTabId === popupId && st.mode === 'armed', `target=${st.targetTabId} popup=${popupId}`);
  await until(async () => !(await state()).privacy, 6000);
  ok('capture continues on the new target after the switch', !(await state()).privacy);
  ok('the switch is a visible system event in the timeline', (await dump('events')).some((e) => /Active Video Target switched/.test(e.label ?? '')));
  await popup.close();
  await page.bringToFront();
  await until(async () => { const s = await state(); return s.terminal === 'target_ended'; }, 6000);
  await rd(() => self.__rd.dispatch({ type: 'DISARM' }));
  void mainId;
  const page2 = await ctx.newPage();
  await page2.goto(`http://localhost:${PORT}/`);
  await page2.bringToFront();
  await rd((id) => self.__rd.armTab(id), await activeTabId());
  await sleep(1500);

  // ------------------------------------------------------------------ Target Ended (B0.8)
  await rd(() => self.__rd.startRepro());
  const endedId = (await state()).sessionId;
  await sleep(2500);
  await page2.close();
  const ended = await until(async () => (await state()).terminal === 'target_ended', 8000);
  ok('closing the target tab enters Target Ended', !!ended);
  const es = await until(async () => (await dump('sessions')).find((s) => s.id === endedId && s.status === 'target_ended'), 8000);
  ok('Repro Session is frozen as target_ended with a system marker', !!es && (await dump('events')).some((e) => e.sessionId === endedId && /Target ended/i.test(e.label ?? '')));
  const capturedAfter = (await dump('events')).filter((e) => e.sessionId === endedId && e.ts > (es?.endedAt ?? 0) + 2000);
  ok('no follow-on capture after the target ended', capturedAfter.length === 0);
} catch (e) {
  console.error('E2E aborted:', e instanceof Error ? e.message : e);
  rep.fail();
} finally {
  await ctx.close().catch(() => undefined);
  server.close();
  rmProfile(userData);
  process.exit(rep.summary() ? 1 : 0);
}
