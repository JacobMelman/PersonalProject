import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildReportModel, draftSteps } from '../../src/report/model';
import { renderHtml } from '../../src/report/render-html';
import { renderMarkdown, renderTxt } from '../../src/report/render-text';
import { renderXlsx } from '../../src/report/render-xlsx';
import { buildEvidencePackage, sha256Hex } from '../../src/report/package';
import { renderDocx } from '../../src/report/render-docx';
import type { ReportRecord, ScreenshotItem, SessionRecord, TimelineEvent } from '../../src/shared/types';

const T0 = 1_800_000_000_000;
const el = (label: string, fp = 'main>button') => ({ tag: 'button', role: 'button', type: null, label, stableId: null, fingerprint: fp, state: [] });
const ev = (ts: number, type: TimelineEvent['type'], extra: Partial<TimelineEvent> = {}): TimelineEvent => ({ sessionId: 's1', ts, type, ...extra });

const session: SessionRecord = {
  id: 's1', kind: 'repro', status: 'finished', createdAt: T0, startedAt: T0, endedAt: T0 + 60_000, lastCommittedAt: T0 + 60_000,
  targetOrigin: 'https://qa.example', environment: 'QA', browser: 'Chrome 140',
  settingsSnapshot: { replaySec: 90, tailSec: 5, preSessionSec: 30, fps: 15, bitrateKbps: 1500 },
  preContext: { startWall: T0 - 30_000, endWall: T0, kept: true },
};
const report: ReportRecord = { id: 'r_s1', sessionId: 's1', title: 'Save <b>fails</b>', actual: 'Nothing happens', expected: 'Saved', notes: '', severity: 'Major', updatedAt: T0 };
const events: TimelineEvent[] = [
  ev(T0 - 10_000, 'click', { element: el('Pre-session click'), path: '/pre' }),
  ev(T0 + 1000, 'click', { element: el('Save'), path: '/customer' }),
  ev(T0 + 1100, 'focus', { element: el('Save') }),
  ev(T0 + 5000, 'navigate', { path: '/cart' }),
  ev(T0 + 6000, 'marker', { label: 'Extra button', ordinal: 1 }),
  ev(T0 + 7000, 'system', { label: 'Privacy Pause start', system: true }),
];
const build = (keepPre: boolean) => buildReportModel({ session, events, shots: [], report, videoInfo: null, keepPre });

describe('report model', () => {
  it('draft steps come only from observed actions, exclude pre-session events and collapse focus noise', () => {
    const steps = draftSteps(events, T0);
    expect(steps.map((s) => s.text)).toEqual(['Click button "Save" on /customer', 'Navigate to /cart']);
  });
  it('a renamed step uses the reporter\'s words and keeps the observed action next to it', () => {
    const [first] = draftSteps(events, T0);
    const steps = draftSteps(events, T0, { [first.key]: '  Save the   customer\n record ' });
    expect(steps[0]).toMatchObject({ text: 'Save the customer record', observed: 'Click button "Save" on /customer', renamed: true });
    expect(steps[1]).toMatchObject({ text: 'Navigate to /cart', renamed: false });
    expect(draftSteps(events, T0, { [first.key]: '   ' })[0]).toMatchObject({ text: first.observed, renamed: false }); // blank = observed
    expect(draftSteps(events, T0, { [first.key]: 'x'.repeat(1000) })[0].text).toHaveLength(300);
  });
  it('step keys are stable (action + time), so a rename survives rebuilding the steps', () => {
    expect(draftSteps(events, T0).map((s) => s.key)).toEqual(draftSteps([...events].reverse(), T0).map((s) => s.key));
    const m = buildReportModel({ session, events, shots: [], report: { ...report, stepTexts: { [draftSteps(events, T0)[1].key]: 'Open the cart' } }, videoInfo: null, keepPre: true });
    expect(m.steps.map((s) => s.text)).toEqual(['Click button "Save" on /customer', 'Open the cart']);
  });
  it('pre-session context is flagged separately and never becomes steps by default', () => {
    expect(build(true).preSession).toEqual({ present: true, kept: true, seconds: 30 });
    expect(build(true).steps.some((s) => /Pre-session/.test(s.text))).toBe(false);
    expect(build(false).preSession.kept).toBe(false);
  });
  it('important moments list user and system markers', () => {
    const m = build(true);
    expect(m.moments.map((x) => x.label)).toEqual(['Extra button', 'Privacy Pause start']);
    expect(m.moments[1].system).toBe(true);
  });
  it('a target-ended / recovered outcome is explicit and cautious', () => {
    const ended = buildReportModel({ session: { ...session, status: 'target_ended', endReason: 'Target tab closed' }, events, shots: [], report, videoInfo: null, keepPre: true });
    expect(ended.endNote).toMatch(/target became unavailable/i);
    const rec = buildReportModel({ session: { ...session, status: 'recovered' }, events, shots: [], report, videoInfo: null, keepPre: true });
    expect(rec.endNote).toMatch(/Recovered Session/);
  });
});

describe('renderers', () => {
  const m = build(true);
  it('HTML escapes user-provided text', () => {
    const html = renderHtml(m, 'inline');
    expect(html).not.toContain('<b>fails</b>');
    expect(html).toContain('Save &lt;b&gt;fails&lt;/b&gt;');
  });
  it('TXT and Markdown include steps, expected and actual', () => {
    for (const out of [renderTxt(m), renderMarkdown(m)]) {
      expect(out).toContain('Click button "Save"');
      expect(out).toContain('Saved');
      expect(out).toContain('Nothing happens');
    }
  });
  it('a renamed step keeps the observed action next to it in every text format (escaped in HTML)', () => {
    const renamed = buildReportModel({ session, events, shots: [], report: { ...report, stepTexts: { [draftSteps(events, T0)[0].key]: 'Save the <b>form</b>' } }, videoInfo: null, keepPre: true });
    expect(renderTxt(renamed)).toMatch(/^ 1\. \[[^\]]+\] Save the <b>form<\/b>\n {4}observed: Click button "Save" on \/customer$/m);
    expect(renderMarkdown(renamed)).toContain('Save the <b>form</b> (observed: Click button "Save" on /customer)');
    expect(renderHtml(renamed, 'inline')).toContain('Save the &lt;b&gt;form&lt;/b&gt;<small class="obs">observed: Click button &quot;Save&quot; on /customer</small>');
    expect(renderTxt(m)).not.toContain('observed:');
  });
  it('TXT never silently drops screenshots', () => {
    const withShot = { ...m, screenshots: [{ id: 'a', ts: T0, rel: '00:01', label: 'Screenshot 1', filename: 'screenshots/01_a.png', width: 1, height: 1 }] };
    expect(renderTxt(withShot)).toContain('screenshots/01_a.png');
  });
  it('XLSX is a well-formed package with three sheets and escaped cells', async () => {
    const blob = renderXlsx(m);
    const zip = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml']));
    expect(strFromU8(zip['xl/worksheets/sheet1.xml'])).toContain('Save &lt;b&gt;fails&lt;/b&gt;');
  });
});

describe('evidence package', () => {
  it('writes a versioned manifest whose hashes match the files', async () => {
    const shot: ScreenshotItem = { id: 'a', sessionId: 's1', ts: T0, origin: null, path: null, title: null, browser: 'x', viewport: null, captureMode: 'repro', bytes: 3, file: 'f', annotations: [] };
    const model = { ...build(true), screenshots: [{ id: 'a', ts: T0, rel: '00:01', label: 'Screenshot 1', filename: 'screenshots/01_a.png', width: 1, height: 1, data: new Uint8Array([1, 2, 3]) }] };
    const blob = await buildEvidencePackage({ model, session, events, shots: [shot], video: null, keepPre: true, version: '0.0.1' });
    const zip = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(zip['manifest.json']));
    expect(manifest.schema_version).toBe(1);
    expect(manifest.capture_policy_version).toBe('0.2.4');
    for (const a of manifest.artifacts) expect(await sha256Hex(zip[a.path])).toBe(a.sha256);
    expect(Object.keys(zip)).toContain('screenshots/01_a.png');
    const raw = JSON.parse(strFromU8(zip['events.json']));
    expect(raw.every((e: { value: unknown }) => e.value === null)).toBe(true);
  });
  it('drops pre-session events from the package when the user removed Pre-session Context', async () => {
    const blob = await buildEvidencePackage({ model: build(false), session, events, shots: [], video: null, keepPre: false, version: '0.0.1' });
    const zip = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(strFromU8(zip['events.json'])).not.toContain('Pre-session click');
  });
});

describe('console & network log in reports', () => {
  const logs: TimelineEvent[] = [
    ev(T0 + 1500, 'console', { log: { level: 'info', source: 'console', text: 'cart loaded' } }),
    ev(T0 + 2000, 'console', { log: { level: 'error', source: 'console', text: 'Payment failed <E-4021>' } }),
    ev(T0 + 2100, 'console', { log: { level: 'error', source: 'exception', text: 'TypeError: x is undefined', stack: 'at pay (https://qa.example/app.js:1:2)' } }),
    ev(T0 + 2500, 'network', { net: { kind: 'fetch', method: 'POST', url: 'https://qa.example/api/order', status: 500, ms: 120 } }),
    ev(T0 + 2600, 'network', { net: { kind: 'resource', method: '', url: 'https://qa.example/logo.png', status: 200, ms: 8, initiator: 'img' } }),
  ];
  const all = [...events, ...logs];
  const withLogs = buildReportModel({ session, events: all, shots: [], report, videoInfo: null, keepPre: true });
  const without = buildReportModel({ session, events: all, shots: [], report, videoInfo: null, keepPre: true, excludeLogs: true });

  it('keeps every entry in the model, puts only problems on the timeline, and never turns them into steps', () => {
    expect(withLogs.devlog?.console).toHaveLength(3);
    expect(withLogs.devlog?.network).toHaveLength(2);
    expect(withLogs.devlog?.problems.map((p) => p.text)).toEqual(['Console error: Payment failed <E-4021>', 'Uncaught TypeError: x is undefined', 'Request failed: POST https://qa.example/api/order → 500 (120 ms)']);
    expect(withLogs.timeline.map((t) => t.text)).toContain('Request failed: POST https://qa.example/api/order → 500 (120 ms)');
    expect(withLogs.timeline.some((t) => /cart loaded|logo\.png/.test(t.text))).toBe(false);
    expect(withLogs.steps).toEqual(build(true).steps);
  });
  it('a report without the log has no section, no timeline rows and no files', async () => {
    expect(without.devlog).toBeNull();
    expect(without.timeline.some((t) => /Request failed|Console/.test(t.text))).toBe(false);
    expect(renderTxt(without)).not.toContain('Console errors and failed requests');
    const zip = unzipSync(new Uint8Array(await (await buildEvidencePackage({ model: without, session, events: all, shots: [], video: null, keepPre: true, version: '0.0.1' })).arrayBuffer()));
    expect(zip['console.json']).toBeUndefined();
    expect(zip['network.har']).toBeUndefined();
    expect(JSON.parse(strFromU8(zip['manifest.json'])).console_network_log).toBeNull();
  });
  it('every text format lists the problems (escaped where it matters)', () => {
    const txt = renderTxt(withLogs);
    expect(txt).toContain('Console errors and failed requests');
    expect(txt).toContain('3 console messages (2 errors), 2 requests (1 failed)');
    expect(txt).toMatch(/\[00:02\] Console error: Payment failed <E-4021>/);
    expect(renderMarkdown(withLogs)).toContain('Console error: Payment failed \\<E-4021\\>');
    const html = renderHtml(withLogs, 'zip');
    expect(html).toContain('Payment failed &lt;E-4021&gt;');
    expect(html).not.toContain('Payment failed <E-4021>');
    expect(html).toContain('All requests (2)');
  });
  it('the ZIP carries console.json, a HAR and a manifest entry; events.json keeps the actions only', async () => {
    const zip = unzipSync(new Uint8Array(await (await buildEvidencePackage({ model: withLogs, session, events: all, shots: [], video: null, keepPre: true, version: '0.0.1' })).arrayBuffer()));
    const con = JSON.parse(strFromU8(zip['console.json']));
    expect(con.map((c: { level: string }) => c.level)).toEqual(['info', 'error', 'error']);
    expect(con[2]).toMatchObject({ ts_ms: 2100, source: 'exception', stack: 'at pay (https://qa.example/app.js:1:2)' });
    const har = JSON.parse(strFromU8(zip['network.har']));
    expect(har.log.entries.map((e: { response: { status: number } }) => e.response.status)).toEqual([500, 200]);
    const manifest = JSON.parse(strFromU8(zip['manifest.json']));
    expect(manifest.console_network_log).toMatchObject({ console_entries: 3, requests: 2, problems: 3, redaction_rules: 'devlog-patterns-v1' });
    for (const a of manifest.artifacts) expect(await sha256Hex(zip[a.path])).toBe(a.sha256);
    expect(JSON.parse(strFromU8(zip['events.json'])).some((e: { type: string }) => e.type === 'console' || e.type === 'network')).toBe(false);
  });
  it('XLSX gets Console and Network sheets, DOCX a problems section', async () => {
    const x = unzipSync(new Uint8Array(await renderXlsx(withLogs).arrayBuffer()));
    expect(strFromU8(x['xl/workbook.xml'])).toMatch(/name="Console".*name="Network"/);
    expect(strFromU8(x['xl/worksheets/sheet5.xml'])).toContain('https://qa.example/api/order');
    expect(Object.keys(unzipSync(new Uint8Array(await renderXlsx(without).arrayBuffer())))).not.toContain('xl/worksheets/sheet4.xml');
    const d = unzipSync(new Uint8Array(await (await renderDocx(withLogs)).arrayBuffer()));
    expect(strFromU8(d['word/document.xml'])).toContain('Console errors and failed requests');
  });
});
