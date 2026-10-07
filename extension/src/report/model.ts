// Platform-neutral Report Model: every renderer (HTML/TXT/Markdown/DOCX/XLSX/ZIP) consumes this, never raw capture internals.
import type { ElementDescriptor, ReportRecord, ScreenshotItem, SessionRecord, TimelineEvent } from '../shared/types';
import { formatClock } from '../shared/filename';

export interface Step {
  n: number;
  ts: number;
  rel: string;
  text: string;
}
export interface Moment {
  ts: number;
  rel: string;
  label: string;
  system: boolean;
  note?: string;
  screenshotId?: string;
}
export interface ShotRef {
  id: string;
  ts: number;
  rel: string;
  label: string;
  filename: string;
  width: number;
  height: number;
  data?: Uint8Array;
}
export interface ReportModel {
  title: string;
  environment: string;
  target: string;
  sessionType: string;
  browser: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: string;
  endNote: string | null;
  steps: Step[];
  preSession: { present: boolean; kept: boolean; seconds: number };
  expected: string;
  actual: string;
  notes: string;
  severity: string;
  moments: Moment[];
  screenshots: ShotRef[];
  timeline: Array<{ rel: string; type: string; text: string }>;
  video: { filename: string; startWall: number; durationMs: number; codec: string; width: number; height: number } | null;
  videoNote: string | null;
}

export const SESSION_TYPE: Record<string, string> = { instant: 'Instant Replay', repro: 'Repro Session', screenshot: 'Screenshot-only' };

export function describeElement(el: ElementDescriptor | undefined): string {
  if (!el) return 'element';
  const role = el.role ?? el.tag;
  const name = el.label ? ` "${el.label}"` : el.stableId ? ` [${el.stableId}]` : '';
  return `${role}${name}`;
}

function eventText(e: TimelineEvent): string {
  switch (e.type) {
    case 'click': return `Click ${describeElement(e.element)}${e.path ? ` on ${e.path}` : ''}`;
    case 'focus': return `Focus ${describeElement(e.element)}`;
    case 'submit': return `Submit ${describeElement(e.element)}`;
    case 'navigate': return `Navigate to ${e.path ?? '/'}`;
    case 'marker': return `Marker: ${e.label ?? ''}${e.note ? ` - ${e.note}` : ''}`;
    case 'screenshot': return e.label ?? 'Screenshot';
    default: return `${e.label ?? 'System event'}${e.note ? ` (${e.note})` : ''}`;
  }
}

/** Deterministic draft Steps (REP-01): observed actions only, no AI, focus noise collapsed, Pre-session Context excluded (REP-04). */
export function draftSteps(events: TimelineEvent[], from: number): Step[] {
  const acts = events.filter((e) => e.ts >= from && ['click', 'navigate', 'submit', 'focus'].includes(e.type)).sort((a, b) => a.ts - b.ts);
  const kept: TimelineEvent[] = [];
  acts.forEach((e, i) => {
    if (e.type === 'focus') {
      const near = (x?: TimelineEvent) => x && x.type === 'click' && x.element?.fingerprint === e.element?.fingerprint && Math.abs(x.ts - e.ts) < 1500;
      if (near(acts[i - 1]) || near(acts[i + 1])) return;
    }
    const prev = kept[kept.length - 1];
    if (prev && prev.type === e.type && eventText(prev) === eventText(e) && e.ts - prev.ts < 400) return; // double-fire
    kept.push(e);
  });
  return kept.map((e, i) => ({ n: i + 1, ts: e.ts, rel: formatClock(e.ts - from), text: eventText(e) }));
}

export interface BuildInput {
  session: SessionRecord;
  events: TimelineEvent[];
  shots: Array<ScreenshotItem & { data?: Uint8Array; width?: number; height?: number }>;
  report: ReportRecord;
  videoInfo: ReportModel['video'];
  keepPre: boolean;
}

export function buildReportModel(inp: BuildInput): ReportModel {
  const { session, events, shots, report, keepPre } = inp;
  const t0 = session.startedAt;
  const rel = (ts: number) => (ts < t0 ? `-${formatClock(t0 - ts)}` : formatClock(ts - t0));
  const pre = session.preContext;
  const visible = events.filter((e) => keepPre || e.ts >= t0).sort((a, b) => a.ts - b.ts);
  const endNote =
    session.status === 'target_ended'
      ? `Capture ended because the target became unavailable${session.endReason ? ` (${session.endReason})` : ''}.${session.classification ? ` Reviewer classification: ${session.classification}${session.classificationNote ? ` - ${session.classificationNote}` : ''}.` : ''}`
      : session.status === 'recovered'
        ? `Recovered Session: recording ended unexpectedly; evidence is complete up to the last committed chunk${session.lastCommittedAt ? ` (${new Date(session.lastCommittedAt).toLocaleString()})` : ''}. ${session.endReason ?? ''}`.trim()
        : null;
  return {
    title: report.title,
    environment: session.environment,
    target: session.targetOrigin ?? 'n/a',
    sessionType: SESSION_TYPE[session.kind] ?? session.kind,
    browser: session.browser,
    startedAt: t0,
    endedAt: session.endedAt,
    durationMs: session.endedAt ? session.endedAt - t0 : null,
    status: session.status,
    endNote,
    steps: draftSteps(visible, t0),
    preSession: { present: !!pre, kept: !!pre && keepPre, seconds: pre ? Math.round((pre.endWall - pre.startWall) / 1000) : 0 },
    expected: report.expected,
    actual: report.actual,
    notes: report.notes,
    severity: report.severity,
    moments: visible
      .filter((e) => e.type === 'marker' || (e.type === 'system' && e.system && /target ended|recorder interrupted|afk|privacy|manual|repro session|screenshot failed|not captured|replay/i.test(e.label ?? '')))
      .map((e) => ({ ts: e.ts, rel: rel(e.ts), label: e.label ?? '', system: !!e.system, note: e.note, screenshotId: e.evidenceId })),
    screenshots: shots
      .sort((a, b) => a.ts - b.ts)
      .map((s, i) => ({ id: s.id, ts: s.ts, rel: rel(s.ts), label: s.markerOrdinal ? `Marker ${s.markerOrdinal}` : `Screenshot ${i + 1}`, filename: `screenshots/${String(i + 1).padStart(2, '0')}_${s.id}.png`, width: s.width ?? 0, height: s.height ?? 0, data: s.data })),
    timeline: visible.map((e) => ({ rel: rel(e.ts), type: e.type, text: eventText(e) })),
    video: inp.videoInfo,
    videoNote: session.videoFailure ?? null,
  };
}

export const defaultTitle = (s: SessionRecord): string => {
  const kind = SESSION_TYPE[s.kind] ?? 'Capture';
  return `${kind} - ${s.targetOrigin ?? 'target'} - ${new Date(s.startedAt).toLocaleString()}`;
};

export function pngSize(data: Uint8Array): { width: number; height: number } {
  if (data.byteLength < 24) return { width: 0, height: 0 };
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}
