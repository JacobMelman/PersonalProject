// Marker screenshots on a STATIC page. Tab capture only delivers frames when something on screen changes, so after a few quiet
// seconds there is no "fresh" frame. A marker or a screenshot must still produce the correct image (found while filming the demo).
import { keyInfo, launch, newReporter, rmProfile, sleep, startSite, tmpProfile } from './lib.mjs';

const PORT = 4183;
const server = await startSite(PORT);
const rep = newReporter();
const ok = rep.ok;
const userData = tmpProfile();
const { ctx, rd, dump, until, activeTabId, setSettings } = await launch(userData);
const failures = async () => (await dump('events')).filter((e) => e.type === 'system' && /Screenshot (failed|not captured)/.test(e.label ?? '')).map((e) => `${e.label}: ${e.note ?? ''}`);

try {
  await setSettings({ replaySec: 30, tailSec: 0, preSessionSec: 0, markerScreenshot: true, openReviewAfterSave: false, fps: 10 });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/popup.html`); // nothing animates on this page
  await page.bringToFront();
  await rd((id) => self.__rd.armTab(id), await activeTabId());
  await sleep(2500);
  await rd(() => self.__rd.startRepro());
  await sleep(7000); // longer than any "recent frame" window: the page is perfectly still
  await rd(() => self.__rd.marker('Static page marker'));
  const one = await until(async () => (await dump('shots')).length >= 1, 8000);
  ok('a marker on a still page still gets its screenshot', !!one, JSON.stringify(await failures()));
  await sleep(6000);
  await rd(() => self.__rd.screenshot());
  const two = await until(async () => (await dump('shots')).length >= 2, 8000);
  ok('a manual screenshot on a still page works too', !!two, JSON.stringify(await failures()));
  const shots = await dump('shots');
  ok('screenshots have real content (non-trivial PNG size)', shots.every((s) => s.bytes > 2000), shots.map((s) => s.bytes).join(','));
  // change the page, wait less than a second, then mark: the screenshot must show the NEW state, not an older frame
  await page.evaluate(() => { document.querySelector('h1').textContent = 'CHANGED-' + 'STATE'; document.body.style.background = 'rgb(255, 0, 0)'; });
  await sleep(400);
  await rd(() => self.__rd.marker('After a change'));
  const three = await until(async () => (await dump('shots')).length >= 3, 8000);
  ok('a marker right after a change gets a screenshot', !!three);
  const last = (await dump('shots')).sort((a, b) => a.ts - b.ts).at(-1);
  const px = await rd(async (file) => {
    const parts = file.split('/'); let d = await navigator.storage.getDirectory();
    for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x);
    const blob = await (await d.getFileHandle(parts.at(-1))).getFile();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const p = g.getImageData(Math.floor(bmp.width * 0.8), Math.floor(bmp.height * 0.8), 1, 1).data;
    return [p[0], p[1], p[2]];
  }, last.file);
  ok('that screenshot shows the changed page (red background), not a stale frame', px[0] > 200 && px[1] < 60 && px[2] < 60, JSON.stringify(px));
  ok('no screenshot failure was logged', (await failures()).length === 0, JSON.stringify(await failures()));

  // "Finish & review" says it opens the report, so it does - even with "Open report after saving" off (set above)
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${keyInfo.id}/sidepanel.html`);
  await panel.waitForSelector('[data-c="finishRepro"]');
  const opened = ctx.waitForEvent('page', { predicate: (p) => p.url().includes('/review.html'), timeout: 10000 }).catch(() => null);
  await panel.click('[data-c="finishRepro"]');
  const rv = await opened;
  ok('"Finish & review" opens the report even when "Open report after saving" is off', !!rv, rv ? 'review tab opened' : 'no review tab');
  const fin = await until(async () => (await dump('sessions')).some((x) => x.kind === 'repro' && x.status === 'finished'), 5000);
  ok('and the session is finished', !!fin);
} catch (e) {
  console.error('static-shot e2e aborted:', e instanceof Error ? e.stack : e);
  rep.fail();
} finally {
  await ctx.close().catch(() => undefined);
  server.close();
  rmProfile(userData);
  process.exit(rep.summary() ? 1 : 0);
}
