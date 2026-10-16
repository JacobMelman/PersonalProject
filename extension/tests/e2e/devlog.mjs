// Console & network log: off by default (nothing is injected, nothing kept); when switched on, console messages, uncaught errors,
// rejections and request metadata of the target are kept, filtered (secrets redacted, query values dropped, never a body), shown
// in Review next to the replay, and exported (errors in the report, console.json + network.har in the ZIP) unless the exporter
// leaves them out. A policy can switch it off, the page recorder's registration goes away on disarm, and a flood is capped.
import { keyInfo, launch, newReporter, rmProfile, setScheme, sleep, startSite, tmpProfile } from './lib.mjs';
import { unzipSync, strFromU8 } from 'fflate';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 4189;
const server = await startSite(PORT);
const rep = newReporter();
const ok = rep.ok;
const userData = tmpProfile();
const { ctx, rd, setSettings, dump, until, activeTabId } = await launch(userData);
const out = mkdtempSync(path.join(tmpdir(), 'rd-devlog-'));
const ORIGIN = `http://localhost:${PORT}`;
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const setPolicy = (p) => rd(async (pol) => { if (pol) await chrome.storage.local.set({ __policy: pol }); else await chrome.storage.local.remove('__policy'); }, p);
const registered = () => rd(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
const saveSession = async (seen) => {
  await rd(() => self.__rd.saveReplay());
  return until(async () => (await dump('sessions')).find((s) => s.kind === 'instant' && s.status !== 'active' && !seen.includes(s.id)), 20000);
};
const logsOf = async (sid) => (await dump('events')).filter((e) => e.sessionId === sid && (e.type === 'console' || e.type === 'network'));
// Everything the page does here runs in its own world, exactly like the app's code would.
const pageActivity = (page, tag) =>
  page.evaluate(async (tag) => {
    console.log(`hello from the page ${tag}`);
    console.warn(`low stock ${tag}`);
    console.error(`Payment failed for jane.doe@bank.example token=abc123secret ${tag}`, { password: 'hunter2', code: 'E-4021' });
    await fetch(`/api/fail?card=4111111111111111&q=${tag}`).catch(() => undefined);
    await fetch('/api/ok', { method: 'POST', body: JSON.stringify({ password: 'hunter2' }) }).catch(() => undefined);
    await new Promise((r) => { const x = new XMLHttpRequest(); x.open('GET', '/api/missing#frag'); x.onloadend = r; x.send(); });
    // one XHR object used twice: one entry per request, not per listener
    await new Promise((r) => { const x = new XMLHttpRequest(); x.open('GET', '/api/ok'); x.onloadend = () => { x.onloadend = r; x.open('GET', '/api/again'); x.send(); }; x.send(); });
    await fetch('http://localhost:1/unreachable').catch(() => undefined);
    setTimeout(() => { throw new Error(`Boom at checkout ${tag}`); });
    Promise.reject(new Error(`Rejected order ${tag}`));
    await new Promise((r) => setTimeout(r, 300));
  }, tag);

try {
  await setSettings({ replaySec: 30, tailSec: 0, preSessionSec: 0, openReviewAfterSave: false, markerScreenshot: false, fps: 5 });
  const page = await ctx.newPage();
  page.on('pageerror', () => undefined); // the uncaught error below is on purpose
  await page.goto(`${ORIGIN}/cart`);
  await page.bringToFront();
  await rd((id) => self.__rd.armTab(id), await activeTabId());
  await sleep(2500);
  const seen = [];

  // ---- off by default
  ok('the log is off by default', (await rd(async () => (await chrome.storage.local.get('settings')).settings?.captureLogs)) !== true);
  await pageActivity(page, 'off');
  await sleep(1200);
  ok('with the log off the page recorder is never injected', (await page.evaluate(() => window.__reprodeskPageLog === true)) === false);
  ok('with the log off no recorder is registered', !(await registered()).includes('rd-pagelog'));
  const off = await saveSession(seen);
  seen.push(off.id);
  ok('with the log off nothing is kept', (await logsOf(off.id)).length === 0);

  // ---- switched on while armed
  await setSettings({ captureLogs: true });
  ok('switching it on starts the recorder on the open page', !!(await until(() => page.evaluate(() => window.__reprodeskPageLog === true), 8000)));
  ok('where host access exists, the recorder is registered for page loads (document_start)', !!(await until(async () => (await registered()).includes('rd-pagelog'), 5000)));
  await pageActivity(page, 'on');
  // a reload: covered from the first line by the registered recorder, and the document request itself is in the log
  await page.reload();
  await sleep(2500);
  await page.evaluate(() => console.error('after reload'));
  await sleep(1500);
  const on = await saveSession(seen);
  seen.push(on.id);
  const logs = await logsOf(on.id);
  const cons = logs.filter((e) => e.type === 'console');
  const nets = logs.filter((e) => e.type === 'network');
  const text = (re) => cons.find((e) => re.test(e.log?.text ?? ''));
  const req = (re) => nets.find((e) => re.test(e.net?.url ?? ''));
  console.log(`kept: ${cons.length} console, ${nets.length} network`);
  ok('console.log / warn / error are kept with their level', text(/^hello from the page on$/)?.log.level === 'info' && text(/^low stock on$/)?.log.level === 'warn' && text(/^Payment failed/)?.log.level === 'error');
  const pay = text(/^Payment failed/)?.log.text ?? '';
  ok('secrets in a console message are redacted before they are stored', pay === 'Payment failed for [email] token=[redacted] on {"password":"[redacted]","code":"E-4021"}', pay);
  ok('an uncaught error is kept as an exception, with its stack', text(/^Error: Boom at checkout on$/)?.log.source === 'exception' && /at /.test(text(/Boom at checkout on/)?.log.stack ?? ''));
  ok('an unhandled rejection is kept', text(/Rejected order on/)?.log.source === 'rejection');
  const fail = req(/\/api\/fail/);
  ok('a failed fetch is kept with method, status and its URL without query values', fail?.net.status === 500 && fail.net.method === 'GET' && fail.net.kind === 'fetch' && fail.net.url === `${ORIGIN}/api/fail?card=…&q=…`, JSON.stringify(fail?.net));
  ok('a POST is kept as metadata only', req(/\/api\/ok$/)?.net.method === 'POST' && req(/\/api\/ok$/)?.net.status === 200);
  ok('XHR is kept, the fragment dropped', req(/\/api\/missing/)?.net.kind === 'xhr' && req(/\/api\/missing/)?.net.status === 404 && req(/\/api\/missing/)?.net.url === `${ORIGIN}/api/missing`);
  ok('a reused XHR object gives one entry per request', nets.filter((e) => e.net.kind === 'xhr' && /\/api\/ok$/.test(e.net.url)).length === 1 && nets.filter((e) => /\/api\/again$/.test(e.net.url)).length === 1);
  ok('a request that never got an answer is kept as failed', req(/localhost:1\//)?.net.error === 'failed');
  ok('after a reload the document request and new messages are recorded', nets.some((e) => e.net.kind === 'document') && !!text(/^after reload$/));
  const raw = JSON.stringify(logs);
  ok('no secret, card number, query value or body reached the store', !/hunter2|4111111111111111|jane\.doe|abc123secret|never-stored-body|#frag/.test(raw));
  ok('nothing from while the log was off sneaked in', !/ off(\b|")/.test(raw.replace(/"origin":"[^"]*"/g, '')));

  // ---- Review
  const rv = await ctx.newPage();
  await rv.goto(`chrome-extension://${keyInfo.id}/review.html?session=${on.id}`);
  await until(() => rv.evaluate(() => { const v = document.getElementById('vid'); return v && v.duration > 0; }), 20000);
  ok('Review shows a Console & network panel', await rv.locator('#devlog').isVisible());
  const tl = await rv.evaluate(() => [...document.querySelectorAll('#tl .tl')].map((r) => r.textContent));
  ok('the timeline shows console errors and failed requests next to the actions', tl.some((t) => /Request failed: GET .*\/api\/fail\?card=… *&? *q=… → 500/.test(t) || /Request failed: GET .*api\/fail.*500/.test(t)) && tl.some((t) => /Console error: Payment failed/.test(t)), tl.filter((t) => /Request|Console|Uncaught/.test(t)).join(' | '));
  ok('but not the ordinary messages', !tl.some((t) => /hello from the page/.test(t)));
  const rowsAll = await rv.locator('#loglist .lg').count();
  await rv.check('#logprob');
  const rowsProb = await rv.locator('#loglist .lg').count();
  ok('"Problems only" narrows the console list', rowsProb > 0 && rowsProb < rowsAll, `${rowsAll} -> ${rowsProb}`);
  await rv.click('[data-logtab="network"]');
  const netRows = await rv.evaluate(() => [...document.querySelectorAll('#loglist .lg')].map((r) => r.textContent));
  ok('the Network tab lists failed requests with their status', netRows.some((t) => /500/.test(t) && /api\/fail/.test(t)) && netRows.some((t) => /failed/.test(t)));
  await rv.evaluate(() => { const v = document.getElementById('vid'); v.pause(); v.currentTime = 0; });
  await rv.locator('#loglist .lg').first().click();
  await sleep(400);
  ok('clicking a log row moves the replay to that moment', (await rv.evaluate(() => document.getElementById('vid').currentTime)) > 0.2);
  for (const scheme of ['light', 'dark']) {
    await setScheme(rv, scheme);
    await rv.evaluate(axeSource);
    const res = await rv.evaluate(() => axe.run({ include: [['#devlog'], ['#tl']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } }));
    const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    ok(`the log panel and timeline have no serious accessibility violations [${scheme}]`, !bad.length, bad.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`).join('; '));
  }
  await setScheme(rv, 'light');

  // ---- export
  const dl = [];
  rv.on('download', (d) => dl.push(d));
  const exportAs = async (fmts, name) => {
    dl.length = 0;
    await rv.evaluate((f) => document.querySelectorAll('[data-fmt]').forEach((c) => (c.checked = f.includes(c.dataset.fmt))), fmts);
    await rv.click('#export');
    await until(async () => dl.length >= fmts.length, 60000);
    const files = {};
    for (const d of dl) {
      const p = path.join(out, `${name}-${d.suggestedFilename()}`);
      await d.saveAs(p);
      files[d.suggestedFilename().split('.').pop()] = readFileSync(p);
    }
    return files;
  };
  ok('the export offers the log, on by default', await rv.locator('#inc-logs').isChecked());
  const withLogs = await exportAs(['zip', 'html', 'txt'], 'with');
  const zip = unzipSync(new Uint8Array(withLogs.zip));
  const har = JSON.parse(strFromU8(zip['network.har'] ?? new Uint8Array()) || '{}');
  const manifest = JSON.parse(strFromU8(zip['manifest.json']));
  ok('the ZIP has console.json and a HAR 1.2 network.har', !!zip['console.json'] && har.log?.version === '1.2' && har.log.entries.some((e) => e.response.status === 500 && e.request.headers.length === 0));
  ok('the manifest describes the log and what is never collected', manifest.console_network_log?.requests === nets.length && manifest.console_network_log.never_collected.includes('request and response bodies') && manifest.artifacts.some((a) => a.path === 'network.har'));
  ok('events.json keeps the actions only', !JSON.parse(strFromU8(zip['events.json'])).some((e) => e.type === 'console' || e.type === 'network'));
  const html = strFromU8(new Uint8Array(withLogs.html));
  const txt = strFromU8(new Uint8Array(withLogs.txt));
  ok('the HTML report has a Console & network section with the errors', /Console &amp; network/.test(html) && /Boom at checkout on/.test(html) && /api\/fail/.test(html));
  ok('the TXT report lists console errors and failed requests', /Console errors and failed requests/.test(txt) && /Request failed: GET .*api\/fail/.test(txt));
  ok('no export carries a secret', ![...Object.values(zip).map((u) => strFromU8(u, true)), html, txt].some((t) => /hunter2|4111111111111111|abc123secret|never-stored-body/.test(t)));

  await rv.uncheck('#inc-logs');
  const without = await exportAs(['zip', 'txt'], 'without');
  const zip2 = unzipSync(new Uint8Array(without.zip));
  ok('leaving the log out drops its files, its section and its timeline rows', !zip2['console.json'] && !zip2['network.har'] && JSON.parse(strFromU8(zip2['manifest.json'])).console_network_log === null && !/Console errors and failed requests|Request failed/.test(strFromU8(new Uint8Array(without.txt))));
  await rv.close();

  // ---- policy and lifecycle
  await page.bringToFront();
  await setPolicy({ ConsoleNetworkLog: false });
  ok('a policy that turns it off removes the page-load registration', !!(await until(async () => !(await registered()).includes('rd-pagelog'), 5000)));
  await page.evaluate(() => console.error('blocked by policy'));
  await sleep(1200);
  const pol = await saveSession(seen);
  seen.push(pol.id);
  ok('with the policy off nothing new is kept, even though the user switched it on', !(await logsOf(pol.id)).some((e) => /blocked by policy/.test(e.log?.text ?? '')));
  await setPolicy(null);
  await until(async () => (await registered()).includes('rd-pagelog'), 5000);

  // a page that logs in a loop is capped per minute and the cap is noted on the timeline
  await page.evaluate(() => { for (let i = 0; i < 1500; i++) console.log('spam', i); });
  await sleep(3000);
  const flood = await saveSession(seen);
  seen.push(flood.id);
  const spam = (await logsOf(flood.id)).filter((e) => /^spam/.test(e.log?.text ?? '')).length;
  const note = (await dump('events')).some((e) => e.type === 'system' && /log limit reached/.test(e.label ?? ''));
  ok('a flood is capped and the cap is noted', spam < 1500 && note, `kept ${spam} of 1500`);

  await rd(() => self.__rd.disarm());
  ok('disarming removes the recorder registration', !!(await until(async () => !(await registered()).includes('rd-pagelog'), 5000)));
} catch (e) {
  console.error('devlog e2e aborted:', e instanceof Error ? e.stack : e);
  rep.fail();
} finally {
  await ctx.close().catch(() => undefined);
  server.close();
  rmProfile(userData);
  rmSync(out, { recursive: true, force: true });
  process.exit(rep.summary() ? 1 : 0);
}
