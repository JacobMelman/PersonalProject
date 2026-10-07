// Shared types for the ReproDesk Phase 0 build. Names follow the product spec (v0.2.4).

export type Mode = 'inactive' | 'armed' | 'repro' | 'screenshot_only';
export type Terminal = null | 'target_ended' | 'error';

/** Capture state. Pause overlays are independent flags so Privacy Pause / Manual Pause / AFK never get conflated. */
export interface CaptureState {
  mode: Mode;
  privacy: boolean;
  manual: boolean;
  afk: boolean;
  /** AFK ended but a Repro Session must be resumed explicitly. */
  afkNeedsResume: boolean;
  terminal: Terminal;
  reason?: string;
  targetTabId: number | null;
  targetWindowId: number | null;
  targetOrigin: string | null;
  /** Active Repro Session id (mode === 'repro') or screenshot session id (mode === 'screenshot_only'). */
  sessionId: string | null;
  /** Lazily created session that collects manual screenshots taken while only Armed. */
  shotSessionId: string | null;
  reproStartedAt: number | null;
  armedAt: number | null;
  markerCount: number;
  afkOverride: boolean;
}

export type DisplayCode =
  | 'inactive'
  | 'armed'
  | 'recording'
  | 'screenshot_only'
  | 'privacy_paused'
  | 'manual_paused'
  | 'afk'
  | 'target_ended'
  | 'error';

export interface Settings {
  replaySec: 30 | 60 | 90 | 120;
  tailSec: 0 | 3 | 5 | 10;
  preSessionSec: 0 | 30;
  fps: number;
  bitrateKbps: number;
  afkMinutes: 0 | 5 | 10 | 15 | 30; // 0 = off
  markerScreenshot: boolean;
  captureVideo: boolean;
  openReviewAfterSave: boolean;
  /** Extra origins that count as the same Target Profile (semantic scope). */
  approvedOrigins: string[];
  environment: string;
}

export const DEFAULT_SETTINGS: Settings = {
  replaySec: 90,
  tailSec: 5,
  preSessionSec: 30,
  fps: 15,
  bitrateKbps: 1500,
  afkMinutes: 10,
  markerScreenshot: true,
  captureVideo: true,
  openReviewAfterSave: true,
  approvedOrigins: [],
  environment: 'QA',
};

export interface SegmentMeta {
  id: string;
  startWall: number;
  endWall: number;
  bytes: number;
  chunkCount: number;
  codec: string;
  width: number;
  height: number;
  /** Session ids that pin this segment. Empty = temporary ring data. */
  refs: string[];
}

export type SessionKind = 'instant' | 'repro' | 'screenshot';
export type SessionStatus = 'active' | 'finished' | 'target_ended' | 'recovered';

export interface SessionRecord {
  id: string;
  kind: SessionKind;
  status: SessionStatus;
  createdAt: number;
  /** Start of the deliberate part (Repro Session Start). Evidence before this is Pre-session Context. */
  startedAt: number;
  endedAt: number | null;
  lastCommittedAt: number | null;
  targetOrigin: string | null;
  environment: string;
  browser: string;
  settingsSnapshot: Pick<Settings, 'replaySec' | 'tailSec' | 'preSessionSec' | 'fps' | 'bitrateKbps'>;
  preContext: { startWall: number; endWall: number; kept: boolean } | null;
  endReason?: string;
  /** Review classification of a Target Ended / recovered session. */
  classification?: string;
  classificationNote?: string;
  videoFailure?: string;
  reviewedAt?: number;
}

export type TimelineType =
  | 'click'
  | 'focus'
  | 'submit'
  | 'navigate'
  | 'marker'
  | 'system'
  | 'screenshot';

export interface ElementDescriptor {
  tag: string;
  role: string | null;
  type: string | null;
  label: string | null;
  stableId: string | null;
  fingerprint: string;
  state: string[];
}

export interface TimelineEvent {
  id?: number;
  sessionId: string; // 'ring' for temporary
  ts: number;
  type: TimelineType;
  tabId?: number;
  origin?: string;
  path?: string;
  element?: ElementDescriptor;
  /** Normalised click position inside the viewport (0..1). */
  pos?: { x: number; y: number };
  label?: string;
  note?: string;
  ordinal?: number;
  system?: boolean;
  evidenceId?: string;
  source?: string;
  confidence?: number;
}

export interface ScreenshotItem {
  id: string;
  sessionId: string;
  ts: number;
  origin: string | null;
  path: string | null;
  title: string | null;
  browser: string;
  viewport: { width: number; height: number } | null;
  captureMode: Mode;
  markerOrdinal?: number;
  bytes: number;
  file: string;
  annotations: unknown[];
}

export interface ReportRecord {
  id: string;
  sessionId: string;
  title: string;
  actual: string;
  expected: string;
  notes: string;
  severity: string;
  updatedAt: number;
}

export interface HealthSnapshot {
  at: number;
  framesIn: number;
  framesEncoded: number;
  framesDropped: number;
  segmentsWritten: number;
  bytesWritten: number;
  ringBytes: number;
  ringSegments: number;
  encoderQueue: number;
  codec: string;
  width: number;
  height: number;
  jsHeapMB: number | null;
  paused: boolean;
  lastChunkAt: number | null;
}
