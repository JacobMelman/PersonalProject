// Enterprise policy enforcement (headless build: the policy is injected through the E2E-only `__policy` key; the real managed-storage
// channel is covered by tests/real/real-policy.mjs). Proves each administrator control actually changes behaviour, fails closed, and is visible to the user.
import { launch, keyInfo, newReporter, rmProfile, sleep, startSite, tmpProfile } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const PORT = 4181;
const ORIGIN = `http://localhost:${PORT}`;
const server = await startSite(PORT);
const rep = newReporter();
const ok = rep.ok;
const userData = tmpProfile();
const { ctx, rd, state, dump, until, activeTabId, setSettings } = await launch(userData, { viewport: { width: 1300, height: 950 } });
const setPolicy = (p) => rd(async (pol) => { if (pol) await chrome.storage.local.set({ __policy: pol }); else await chrome.storage.local.remove('__policy'); }, p);
const notice = () => rd(async () => (await chrome.storage.session.get('notice')).notice ?? null);

try {
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/`);
  await page.bringToFront();
  const tab = await activeTabId();

  // ---------------------------------------------------------------- where ReproDesk may run
  await setPolicy({ BlockedOrigins: ['http://localhost:*'] });
  await sleep(300);
  await rd((id) => self.__rd.armTab(id), tab);
  ok('a blocked site cannot be armed', (await state()).mode === 'inactive');
  const n1 = await notice();
  ok('the user is told why (organization policy), not left guessing', !!n1 && /organization/i.test(n1.text), n1?.text);

  await setPolicy({ AllowedTargetOrigins: ['https://*.corp.example'] });
  await sleep(300);
  await rd((id) => self.__rd.armTab(id), tab);
  ok('a site outside the allow-list cannot be armed', (await state()).mode === 'inactive');

  await setPolicy({ AllowedTargetOrigins: ['corp.example'] });
  await sleep(300);
  await rd((id) => self.__rd.armTab(id), tab);
  ok('an allow-list with only invalid patterns allows nothing (fail closed)', (await state()).mode === 'inactive');

  await setPolicy({ AllowedTargetOrigins: ['https://*.corp.example', 'http://localhost:*'], BlockedOrigins: ['https://hr.corp.example'] });
  await sleep(300);
  await rd((id) => self.__rd.armTab(id), tab);
  ok('a site on the allow-list arms normally', (await state()).mode === 'armed');

  await setPolicy({ AllowedTargetOrigins: ['https://*.corp.example', 'http://localhost:*'], BlockedOrigins: [`${ORIGIN}`] });
  const stopped = await until(async () => (await state()).mode === 'inactive', 8000);
  ok('tightening the policy while armed stops the capture at once', !!stopped);
  const n2 = await notice();
  ok('and says so', !!n2 && /disarmed/i.test(n2.text), n2?.text);
  await rd((id) => { /* keep the page referenced so the tab stays alive */ return id; }, tab);

  // ---------------------------------------------------------------- video forbidden -> Screenshot-only
  await setPolicy({ VideoCaptureAllowed: false });
  await sleep(300);
  await setSettings({ captureVideo: true });
  await rd((id) => self.__rd.armTab(id), tab);
  ok('VideoCaptureAllowed=false arms Screenshot-only (no video), whatever the user chose', (await state()).mode === 'screenshot_only');
  await rd(() => self.__rd.disarm());

  // ---------------------------------------------------------------- locked settings in the side panel
  await setPolicy({ ReplayWindowSec: 60, PostTriggerTailSec: 3, MarkerScreenshots: false, EnvironmentLabel: 'QA-managed', AfkAutoPauseMinutes: 5, ApprovedOrigins: ['https://sso.corp.example'], SampleSessionsEnabled: false });
  await setSettings({ replaySec: 120, tailSec: 10, markerScreenshot: true, environment: 'my own' });
  const sp = await ctx.newPage();
  await sp.setViewportSize({ width: 420, height: 1100 });
  await sp.goto(`chrome-extension://${keyInfo.id}/sidepanel.html`);
  await sp.waitForSelector('[data-nav="settings"]');
  ok('empty state has no sample button when the policy turns samples off', (await sp.locator('#load-sample').count()) === 0);
  await sp.click('[data-nav="settings"]');
  await sp.waitForSelector('#managed-banner');
  ok('settings say the browser is managed by the organization', /Managed by your organization/.test(await sp.locator('#managed-banner').innerText()));
  const on = (key) => sp.locator(`[data-seg="${key}"].on`).innerText();
  ok('the administrator\'s values win over the user\'s own', (await on('replaySec')) === '60s' && (await on('tailSec')) === '3s' && (await on('afkMinutes')) === '5m');
  const allDisabled = async (key) => (await sp.locator(`[data-seg="${key}"]`).evaluateAll((els) => els.every((e) => e.disabled)));
  ok('locked controls are disabled', (await allDisabled('replaySec')) && (await allDisabled('tailSec')) && (await allDisabled('afkMinutes')) && (await sp.locator('[data-sb="markerScreenshot"]').isDisabled()) && (await sp.locator('[data-s="environment"]').isDisabled()));
  ok('unlocked controls stay editable', !(await sp.locator('[data-sb="captureVideo"]').isDisabled()) && !(await sp.locator('[data-seg="fps"]').first().isDisabled()));
  ok('environment label comes from the policy', (await sp.inputValue('[data-s="environment"]')) === 'QA-managed');
  ok('organization-approved origins are shown as set by the organization', /sso\.corp\.example/.test(await sp.locator('.field .hint', { hasText: 'Added by your organization' }).innerText()));
  ok('the sample-data section is gone', (await sp.locator('#load-sample').count()) === 0);
  const own = await rd(async () => (await chrome.storage.local.get('settings')).settings);
  ok('the user\'s own stored values were not overwritten by the policy', own.replaySec === 120 && own.tailSec === 10 && own.environment === 'my own', JSON.stringify({ r: own.replaySec, t: own.tailSec }));
  const diag = JSON.parse(await sp.locator('#diag').innerText());
  ok('diagnostics report that a policy is active', diag.policy?.managed === true && diag.policy.locked.includes('replaySec'));
  // accessibility of the managed UI in both themes
  for (const scheme of ['light', 'dark']) {
    await sp.emulateMedia({ colorScheme: scheme });
    await sp.evaluate(axeSource);
    const res = await sp.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } }));
    const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    ok(`managed settings view [${scheme}]: no serious or critical accessibility violations`, bad.length === 0, bad.map((v) => `${v.id} x${v.nodes.length}: ${v.nodes.slice(0, 2).map((x) => x.target.join(' ')).join(' | ')}`).join('; '));
  }
  await sp.emulateMedia({ colorScheme: 'light' });

  // ---------------------------------------------------------------- export controls + retention need real sessions: load the sample
  await setPolicy(null);
  await sp.goto(`chrome-extension://${keyInfo.id}/sidepanel.html`);
  await sp.waitForSelector('#load-sample');
  await sp.click('#load-sample');
  await until(async () => (await dump('sessions')).length >= 2, 20000);
  await sleep(700);
  const sessions = await dump('sessions');
  const repro = sessions.find((s) => s.kind === 'repro');
  // give one screenshot an annotation so the "include originals" switch would normally appear
  await rd(async (sid) => {
    const db = await new Promise((res, rej) => { const q = indexedDB.open('reprodesk'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const all = await new Promise((res) => { const q = db.transaction('shots').objectStore('shots').getAll(); q.onsuccess = () => res(q.result); });
    const sh = all.find((x) => x.sessionId === sid);
    sh.annotations = [{ id: 'a1', type: 'rect', x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.3, color: '#e5384a' }];
    await new Promise((res) => { const t = db.transaction('shots', 'readwrite'); t.objectStore('shots').put(sh); t.oncomplete = res; });
  }, repro.id);

  const rv = await ctx.newPage();
  await rv.setViewportSize({ width: 1300, height: 950 });
  const openReview = async () => {
    await rv.goto(`chrome-extension://${keyInfo.id}/review.html?session=${repro.id}`);
    await rv.waitForSelector('#fname');
  };
  await openReview();
  ok('without policy: all six formats, originals switch and copy buttons are offered', (await rv.locator('[data-fmt]').count()) === 6 && (await rv.locator('#inc-orig').count()) === 1 && (await rv.locator('#cpmd').count()) === 1);

  await setPolicy({ AllowedExportFormats: ['html', 'txt'], AllowUnredactedOriginals: false, RequireExportConfirmation: true });
  await sleep(300);
  await openReview();
  const fmts = await rv.locator('[data-fmt]').evaluateAll((els) => els.map((e) => e.dataset.fmt));
  ok('only the allowed formats are offered', fmts.length === 2 && fmts.includes('html') && fmts.includes('txt'), fmts.join(','));
  ok('the originals switch is gone when originals are not allowed', (await rv.locator('#inc-orig').count()) === 0);
  ok('copy buttons follow the allowed formats (Markdown hidden, Text shown)', (await rv.locator('#cpmd').count()) === 0 && (await rv.locator('#cptxt').count()) === 1);
  ok('the user sees that export options are managed', (await rv.locator('#export-managed').count()) === 1);

  const downloads = [];
  rv.on('download', (d) => downloads.push(d));
  await rv.evaluate(() => document.querySelectorAll('[data-fmt]').forEach((c) => (c.checked = true)));
  let dialogs = 0;
  rv.once('dialog', async (d) => { dialogs++; await d.dismiss(); });
  await rv.click('#export');
  await sleep(2500);
  ok('declining the confirmation exports nothing', dialogs === 1 && downloads.length === 0, `dialogs=${dialogs} downloads=${downloads.length}`);
  rv.once('dialog', async (d) => { dialogs++; await d.accept(); });
  await rv.click('#export');
  await until(async () => downloads.length >= 2, 20000);
  ok('accepting the confirmation exports exactly the allowed formats', downloads.length === 2 && downloads.every((d) => /\.(html|txt)$/.test(d.suggestedFilename())), downloads.map((d) => d.suggestedFilename()).join(','));

  await setPolicy({ AllowedExportFormats: ['pdf'] });
  await sleep(300);
  await openReview();
  ok('a format list naming nothing known turns export off, visibly', (await rv.locator('#export').count()) === 0 && (await rv.locator('#export-none').count()) === 1);

  // ---------------------------------------------------------------- retention
  await setPolicy({ SessionRetentionDays: 30 });
  const instant = sessions.find((s) => s.kind === 'instant');
  await rd(async (sid) => {
    const db = await new Promise((res, rej) => { const q = indexedDB.open('reprodesk'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const rec = await new Promise((res) => { const q = db.transaction('sessions').objectStore('sessions').get(sid); q.onsuccess = () => res(q.result); });
    const old = Date.now() - 40 * 86_400_000;
    rec.createdAt = old - 60_000; rec.startedAt = old - 60_000; rec.endedAt = old;
    await new Promise((res) => { const t = db.transaction('sessions', 'readwrite'); t.objectStore('sessions').put(rec); t.oncomplete = res; });
  }, instant.id);
  const deleted = await rd(() => self.__rd.retention());
  const left = await dump('sessions');
  ok('retention deletes the expired finished session and keeps the recent one', deleted === 1 && left.length === 1 && left[0].id === repro.id, `deleted=${deleted}`);
  const segLeft = await dump('segments');
  ok('and its media is gone too (segments still referenced only by the kept session)', segLeft.length > 0 && segLeft.every((s) => s.refs.every((r) => r === repro.id)));
  await setPolicy({ SessionRetentionDays: 0 });
  await rd(async (sid) => {
    const db = await new Promise((res, rej) => { const q = indexedDB.open('reprodesk'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const rec = await new Promise((res) => { const q = db.transaction('sessions').objectStore('sessions').get(sid); q.onsuccess = () => res(q.result); });
    const old = Date.now() - 400 * 86_400_000;
    rec.createdAt = old; rec.endedAt = old;
    await new Promise((res) => { const t = db.transaction('sessions', 'readwrite'); t.objectStore('sessions').put(rec); t.oncomplete = res; });
  }, repro.id);
  const none = await rd(() => self.__rd.retention());
  ok('retention 0 = keep forever, however old', none === 0 && (await dump('sessions')).length === 1);
} catch (e) {
  console.error('policy e2e aborted:', e instanceof Error ? e.stack : e);
  rep.fail();
} finally {
  await ctx.close().catch(() => undefined);
  server.close();
  rmProfile(userData);
  process.exit(rep.summary() ? 1 : 0);
}
