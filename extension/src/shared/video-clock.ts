// Wall-clock time <-> time in the replay video. A capture pause (Privacy Pause, manual pause, AFK) records nothing, so the
// replay must not show it as the last frame frozen for the length of the pause: each pause is collapsed to a short
// "not recorded" card. Gaps without a pause (a still page sends no frames) stay as they are: the screen really did not change.
import type { PauseReason, SegmentMeta } from './types';

/** How long the "not recorded" card is shown in place of a pause. */
export const PAUSE_CARD_MS = 1500;
/** Shorter pauses are left as they are: collapsing them would save nothing. */
const MIN_COLLAPSE_MS = PAUSE_CARD_MS + 500;

export interface VideoPause {
  /** Wall-clock span that was not recorded. */
  fromWall: number;
  toWall: number;
  /** Where the card starts in the video, and how long it is shown. */
  atMs: number;
  holdMs: number;
  reason?: PauseReason;
}

export interface VideoClock {
  startWall: number;
  pauses: VideoPause[];
}

type ClockSegment = Pick<SegmentMeta, 'startWall' | 'endWall' | 'pausedFrom' | 'pauseReason'>;

/** The clock of a video muxed from `run` (segments in time order). */
export function buildClock(run: ClockSegment[]): VideoClock {
  const startWall = run[0]?.startWall ?? 0;
  const pauses: VideoPause[] = [];
  let removed = 0;
  let prevEnd = startWall;
  for (const s of run) {
    if (s.pausedFrom != null) {
      const from = Math.max(prevEnd, s.pausedFrom);
      const to = s.startWall;
      if (to - from > MIN_COLLAPSE_MS) {
        pauses.push({ fromWall: from, toWall: to, atMs: from - startWall - removed, holdMs: PAUSE_CARD_MS, reason: s.pauseReason });
        removed += to - from - PAUSE_CARD_MS;
      }
    }
    prevEnd = Math.max(prevEnd, s.endWall);
  }
  return { startWall, pauses };
}

/** Milliseconds into the video for a wall-clock moment (a moment inside a pause lands on its card). */
export function wallToVideoMs(c: VideoClock, wall: number): number {
  let removed = 0;
  for (const p of c.pauses) {
    if (wall >= p.toWall) {
      removed += p.toWall - p.fromWall - p.holdMs;
      continue;
    }
    if (wall > p.fromWall) return p.atMs + ((wall - p.fromWall) / (p.toWall - p.fromWall)) * p.holdMs;
    break;
  }
  return wall - c.startWall - removed;
}

/** The wall-clock moment shown at `ms` into the video (inverse of wallToVideoMs). */
export function videoMsToWall(c: VideoClock, ms: number): number {
  let removed = 0;
  for (const p of c.pauses) {
    if (ms >= p.atMs + p.holdMs) {
      removed += p.toWall - p.fromWall - p.holdMs;
      continue;
    }
    if (ms > p.atMs) return p.fromWall + ((ms - p.atMs) / p.holdMs) * (p.toWall - p.fromWall);
    break;
  }
  return c.startWall + ms + removed;
}

export function pauseLabel(reason?: PauseReason): string {
  return reason === 'privacy' ? 'Privacy Pause' : reason === 'manual' ? 'Paused' : reason === 'afk' ? 'Away (AFK)' : 'Capture paused';
}
