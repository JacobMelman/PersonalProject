import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildReportModel, draftSteps } from '../../src/report/model';
import { renderHtml } from '../../src/report/render-html';
import { renderMarkdown, renderTxt } from '../../src/report/render-text';
import { renderXlsx } from '../../src/report/render-xlsx';
import { buildEvidencePackage, sha256Hex } from '../../src/report/package';
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
