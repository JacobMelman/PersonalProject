// Recovery Journal / Recovered Session (B0.15): the browser disappears mid-session, the next start reopens committed evidence.
import { launch, keyInfo, newReporter, rmProfile, sleep, startSite, tmpProfile } from './lib.mjs';

const PORT = 4176;
const server = await startSite(PORT);
const rep = newReporter();
const ok = rep.ok;
const userData = tmpProfile();
let sessionId = null;
try {
  {
    const a = await launch(userData);
    await a.setSettings({ replaySec: 30, tailSec: 0, preSessionSec: 0, openReviewAfterSave: false, fps: 10, bitrateKbps: 1000 });
    const page = await a.ctx.newPage();
    await page.goto(`http://localhost:${PORT}/`);
    await page.bringToFront();
    await a.rd((id) => self.__rd.armTab(id), await a.activeTabId());
    await sleep(1500);
    await a.rd(() => self.__rd.startRepro());
    sessionId = (await a.state()).sessionId;
    await page.click('#add');
    await page.click('#nav-cart');
    await sleep(9000); // several GOPs get committed to storage
    const segs = (await a.dump('segments')).filter((s) => s.refs.includes(sessionId));
    ok('session has committed (pinned) segments before the interruption', segs.length >= 2, `segments=${segs.length}`);
    // No Finish, no disarm: the browser just goes away.
    await a.ctx.close();
  }
  {
    const b = await launch(userData);
    await sleep(2500);
    const sess = (await b.dump('sessions')).find((s) => s.id === sessionId);
    ok('interrupted session is reopened as a Recovered Session, not a clean Finish', sess?.status === 'recovered', `status=${sess?.status}`);
    ok('last committed timestamp is recorded', !!sess?.lastCommittedAt);
    const ev = (await b.dump('events')).filter((e) => e.sessionId === sessionId);
    ok('timeline shows a system "Recorder interrupted" marker and the earlier clicks', ev.some((e) => /Recorder interrupted/.test(e.label ?? '')) && ev.some((e) => e.type === 'click'));
    const st = await b.state();
    ok('capture state after restart is honest (inactive, not a stale REC)', st.mode === 'inactive');
    const rv = await b.ctx.newPage();
    await rv.goto(`chrome-extension://${keyInfo.id}/review.html?session=${sessionId}`);
    const v = await b.until(() => rv.evaluate(() => { const x = document.getElementById('vid'); return x && x.duration > 0 ? { w: x.videoWidth, d: x.duration } : null; }), 15000);
    ok('committed video of the recovered session plays in Review', !!v && v.w > 0, v ? `${v.d.toFixed(1)}s` : 'no video');
    const text = await rv.evaluate(() => document.body.innerText);
    ok('Review states the recovered outcome explicitly', /Recovered Session/.test(text));
    await b.ctx.close();
  }
} catch (e) {
  console.error('recovery e2e aborted:', e instanceof Error ? e.stack : e);
  rep.fail();
} finally {
  server.close();
  rmProfile(userData);
  process.exit(rep.summary() ? 1 : 0);
}
