import { describe, expect, it } from 'vitest';
import { buildClock, PAUSE_CARD_MS, videoMsToWall, wallToVideoMs } from '../../src/shared/video-clock';

// 8 s on the page, a 20 s Privacy Pause, 5 s on the page again (the reported case)
const T0 = 1_000_000;
const run = [
  { startWall: T0, endWall: T0 + 8000 },
  { startWall: T0 + 28000, endWall: T0 + 33000, pausedFrom: T0 + 8000, pauseReason: 'privacy' as const },
];

describe('video clock', () => {
  it('collapses a capture pause to a short card', () => {
    const c = buildClock(run);
    expect(c.pauses).toEqual([{ fromWall: T0 + 8000, toWall: T0 + 28000, atMs: 8000, holdMs: PAUSE_CARD_MS, reason: 'privacy' }]);
    expect(wallToVideoMs(c, T0 + 33000)).toBe(13000 + PAUSE_CARD_MS); // 13 s captured + the card, not 33 s
  });

  it('maps both ways and keeps time before and after the pause linear', () => {
    const c = buildClock(run);
    for (const wall of [T0, T0 + 4000, T0 + 8000, T0 + 28000, T0 + 30500, T0 + 33000]) expect(videoMsToWall(c, wallToVideoMs(c, wall))).toBeCloseTo(wall, 6);
    expect(wallToVideoMs(c, T0 + 4000)).toBe(4000);
    expect(wallToVideoMs(c, T0 + 30000)).toBe(8000 + PAUSE_CARD_MS + 2000);
  });

  it('puts a moment inside the pause on its card', () => {
    const c = buildClock(run);
    const v = wallToVideoMs(c, T0 + 18000);
    expect(v).toBeGreaterThan(8000);
    expect(v).toBeLessThan(8000 + PAUSE_CARD_MS);
  });

  it('leaves a gap without a pause alone: a still page really did not change', () => {
    const still = [{ startWall: T0, endWall: T0 + 8000 }, { startWall: T0 + 28000, endWall: T0 + 33000 }];
    const c = buildClock(still);
    expect(c.pauses).toEqual([]);
    expect(wallToVideoMs(c, T0 + 33000)).toBe(33000);
  });

  it('collapses only the paused part when the page was still before the pause began', () => {
    const c = buildClock([{ startWall: T0, endWall: T0 + 3000 }, { startWall: T0 + 28000, endWall: T0 + 30000, pausedFrom: T0 + 8000 }]);
    expect(c.pauses[0].fromWall).toBe(T0 + 8000);
    expect(wallToVideoMs(c, T0 + 30000)).toBe(8000 + PAUSE_CARD_MS + 2000);
  });

  it('ignores pauses too short to matter and pauses before the first segment', () => {
    expect(buildClock([{ startWall: T0, endWall: T0 + 1000 }, { startWall: T0 + 2500, endWall: T0 + 3000, pausedFrom: T0 + 1000 }]).pauses).toEqual([]);
    expect(buildClock([{ startWall: T0, endWall: T0 + 1000, pausedFrom: T0 - 60000 }]).pauses).toEqual([]);
  });

  it('handles several pauses in a row', () => {
    const c = buildClock([
      { startWall: T0, endWall: T0 + 2000 },
      { startWall: T0 + 12000, endWall: T0 + 14000, pausedFrom: T0 + 2000, pauseReason: 'manual' as const },
      { startWall: T0 + 44000, endWall: T0 + 46000, pausedFrom: T0 + 14000, pauseReason: 'afk' as const },
    ]);
    expect(c.pauses.map((p) => p.atMs)).toEqual([2000, 4000 + PAUSE_CARD_MS]);
    expect(wallToVideoMs(c, T0 + 46000)).toBe(6000 + 2 * PAUSE_CARD_MS);
    expect(videoMsToWall(c, 6000 + 2 * PAUSE_CARD_MS)).toBe(T0 + 46000);
  });
});
