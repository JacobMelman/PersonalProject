// Platform-neutral Report Model: every renderer (HTML/TXT/Markdown/DOCX/XLSX/ZIP) consumes this, never raw capture internals.
import type { ElementDescriptor, ReportRecord, ScreenshotItem, SessionRecord, TimelineEvent } from '../shared/types';
import { formatClock } from '../shared/filename';
import { consoleText, isConsoleProblem, isNetProblem, netText, type ConsoleEntry, type NetEntry } from '../shared/devlog';

export interface Step {
  n: number;
  ts: number;
  rel: string;
  /** What the report says: the reporter's wording if they renamed the step, else the observed action. */
  text: string;
  /** Stable id of the step (its action and time), for keeping a rename when the steps are rebuilt. */
  key: string;
  /** The observed action as recorded. */
  observed: string;
  renamed: boolean;
}

/** Longest step name a reporter can give. */
export const STEP_TEXT_MAX = 300;
/** A rename as it is stored: one line, trimmed, bounded; empty means "back to the observed action". */
export const cleanStepText = (t: string): string => t.replace(/\s+/g, ' ').trim().slice(0, STEP_TEXT_MAX);
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
export interface ConsoleRow extends ConsoleEntry {
  ts: number;
  rel: string;
}
export interface NetRow extends NetEntry {
  ts: number;
  rel: string;
}
/** The Console & network log as a report carries it: every kept entry, plus the problems a reader should look at first. */
export interface DevLog {
  console: ConsoleRow[];
  network: NetRow[];
  problems: Array<{ ts: number; rel: string; kind: 'console' | 'network'; text: string }>;
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
  /** null: the session has no console / network entries, or the exporter left them out. */
  devlog: DevLog | null;
}

export const SESSION_TYPE: Record<string, string> = { instant: 'Instant Replay', repro: 'Repro Session', screenshot: 'Screenshot-only' };

export function describeElement(el: ElementDescriptor | undefined): string {
  if (!el) return 'element';
  const role = el.role ?? el.tag;
  const name = el.label ? ` "${el.label}"` : el.stableId ? ` [${el.stableId}]` : '';
  return `${role}${name}`;
}

export const isLogEvent = (e: TimelineEvent): boolean => e.type === 'console' || e.type === 'network';
/** A log entry the timeline shows next to the actions: console errors, uncaught errors and failed requests (the rest stays in the log). */
export const isLogProblem = (e: TimelineEvent): boolean => (e.type === 'console' && !!e.log && isConsoleProblem(e.log)) || (e.type === 'network' && !!e.net && isNetProblem(e.net));
export const onTimeline = (e: TimelineEvent): boolean => !isLogEvent(e) || isLogProblem(e);

function eventText(e: TimelineEvent): string {
  switch (e.type) {
    case 'console': return e.log ? (e.log.source === 'console' ? `Console ${e.log.level}: ${e.log.text}` : consoleText(e.log)) : 'Console message';
    case 'network': return e.net ? `Request failed: ${netText(e.net)}` : 'Request';
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
export function draftSteps(events: TimelineEvent[], from: number, names: Record<string, string> = {}): Step[] {
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
  return kept.map((e, i) => {
    const key = `${e.type}@${e.ts}`;
    const observed = eventText(e);
    const own = names[key] ? cleanStepText(names[key]) : '';
    return { n: i + 1, ts: e.ts, rel: formatClock(e.ts - from), key, observed, text: own || observed, renamed: !!own };
  });
}

export interface BuildInput {
  session: SessionRecord;
  events: TimelineEvent[];
  shots: Array<ScreenshotItem & { data?: Uint8Array; width?: number; height?: number }>;
  report: ReportRecord;
  videoInfo: ReportModel['video'];
  keepPre: boolean;
  /** Leave the Console & network log out of this report (default: in). */
  excludeLogs?: boolean;
}

export function buildReportModel(inp: BuildInput): ReportModel {
  const { session, events, shots, report, keepPre } = inp;
  const t0 = session.startedAt;
  const rel = (ts: number) => (ts < t0 ? `-${formatClock(t0 - ts)}` : formatClock(ts - t0));
  const pre = session.preContext;
  const all = events.filter((e) => keepPre || e.ts >= t0).sort((a, b) => a.ts - b.ts);
  const visible = all.filter((e) => (inp.excludeLogs ? !isLogEvent(e) : onTimeline(e)));
  const logs = inp.excludeLogs ? [] : all.filter(isLogEvent);
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
    steps: draftSteps(visible, t0, report.stepTexts),
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
    devlog: logs.length
      ? {
          console: logs.filter((e) => e.type === 'console' && e.log).map((e) => ({ ts: e.ts, rel: rel(e.ts), ...e.log! })),
          network: logs.filter((e) => e.type === 'network' && e.net).map((e) => ({ ts: e.ts, rel: rel(e.ts), ...e.net! })),
          problems: logs.filter(isLogProblem).map((e) => ({ ts: e.ts, rel: rel(e.ts), kind: e.type as 'console' | 'network', text: eventText(e) })),
        }
      : null,
  };
}

export const defaultTitle = (s: SessionRecord): string => {
  const kind = SESSION_TYPE[s.kind] ?? 'Capture';
  return `${s.sample ? '[Sample] ' : ''}${kind} on ${(s.targetOrigin ?? 'target').replace(/^https?:\/\//, '')}`;
};

export function pngSize(data: Uint8Array): { width: number; height: number } {
  if (data.byteLength < 24) return { width: 0, height: 0 };
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}
