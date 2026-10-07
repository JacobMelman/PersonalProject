import type { Settings, TimelineEvent } from './types';

export type Command =
  | 'saveReplay'
  | 'startRepro'
  | 'finishRepro'
  | 'marker'
  | 'screenshot'
  | 'manualPause'
  | 'manualResume'
  | 'resumeFromAfk'
  | 'disarm'
  | 'ackTerminal'
  | 'openReview'
  | 'finishShotSession'
  | 'siteRemembered';

export interface CommandMessage {
  kind: 'cmd';
  cmd: Command;
  payload?: Record<string, unknown>;
}

/** Service worker -> offscreen document. */
export type OffscreenOp =
  | { kind: 'off'; op: 'start'; streamId: string; settings: Settings; size?: { width: number; height: number } }
  | { kind: 'off'; op: 'stop' }
  | { kind: 'off'; op: 'pause' }
  | { kind: 'off'; op: 'resume' }
  | { kind: 'off'; op: 'config'; settings: Settings }
  | { kind: 'off'; op: 'save-replay'; sessionId: string; triggerWall: number; preMs: number; tailMs: number }
  | { kind: 'off'; op: 'pin-start'; sessionId: string; startWall: number; preMs: number }
  | { kind: 'off'; op: 'pin-stop'; sessionId: string }
  | { kind: 'off'; op: 'flush' }
  | { kind: 'off'; op: 'screenshot'; file: string };

export interface PinResult {
  ok: boolean;
  startWall: number | null;
  endWall: number | null;
  segments: number;
  videoError?: string;
}

/** Offscreen document -> service worker. */
export type OffscreenEvent =
  | { kind: 'off-event'; ev: 'started'; codec: string; width: number; height: number }
  | { kind: 'off-event'; ev: 'ended'; reason: string }
  | { kind: 'off-event'; ev: 'error'; reason: string };

/** Content script -> service worker (over a long-lived port named PORT_NAME). */
export const PORT_NAME = 'rd-content';
/** Sub-frames (same-origin or approved-origin iframes) only send events; liveness is judged on the top frame. */
export const FRAME_PORT_NAME = 'rd-frame';
export type ContentMessage =
  | { t: 'hello'; origin: string; path: string; visible: boolean }
  | { t: 'ping' }
  | { t: 'bye' }
  | { t: 'event'; ev: Omit<TimelineEvent, 'sessionId' | 'ts' | 'tabId'> & { ts?: number } };
