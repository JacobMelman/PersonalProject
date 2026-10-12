import { describe, expect, it } from 'vitest';
import { activeClicks, CLICK_MARK_MS, clickMarks, clickTicks } from '../../src/shared/click-marks';
import { buildClock } from '../../src/shared/video-clock';
import type { TimelineEvent } from '../../src/shared/types';

const T0 = 1_000_000;
const ev = (ts: number, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({ id: `e${ts}`, ts, type: 'click', pos: { x: 0.5, y: 0.25 }, ...extra }) as TimelineEvent;

describe('click marks', () => {
  const clock = buildClock([{ startWall: T0, endWall: T0 + 10000 }]);

  it('turns top-document clicks into marks on the video clock', () => {
    const m = clickMarks([ev(T0 + 2000), ev(T0 + 500, { type: 'focus' } as Partial<TimelineEvent>), ev(T0 + 3000, { frame: true })], clock, 10000);
    expect(m).toEqual([{ atMs: 2000, x: 0.5, y: 0.25 }]);
  });

  it('leaves out clicks without a position and clicks outside the video', () => {
    expect(clickMarks([ev(T0 + 1000, { pos: undefined }), ev(T0 - 500), ev(T0 + 20000)], clock, 10000)).toEqual([]);
  });

  it('follows the video clock across a collapsed pause', () => {
    const paused = buildClock([{ startWall: T0, endWall: T0 + 2000 }, { startWall: T0 + 22000, endWall: T0 + 25000, pausedFrom: T0 + 2000 }]);
    expect(clickMarks([ev(T0 + 23000)], paused, 10000)[0].atMs).toBe(2000 + 1500 + 1000);
  });

  it('is active for a short time after the click only', () => {
    const marks = [{ atMs: 1000, x: 0.1, y: 0.1 }];
    expect(activeClicks(marks, 999)).toEqual([]);
    expect(activeClicks(marks, 1000)).toHaveLength(1);
    expect(activeClicks(marks, 1000 + CLICK_MARK_MS)).toEqual([]);
  });

  it('asks the re-encoder for frames through the animation and one clean frame at its end', () => {
    const t = clickTicks([{ atMs: 1000, x: 0, y: 0 }], 200);
    expect(t[0]).toBe(1000);
    expect(t.at(-1)).toBe(1000 + CLICK_MARK_MS);
    expect(t.every((x, i) => i === 0 || x > t[i - 1])).toBe(true);
  });
});

describe('click marks on a letterboxed frame', () => {
  const clock = buildClock([{ startWall: T0, endWall: T0 + 10000 }]);
  it('maps the viewport position through the fit when the frame has bars', () => {
    // a 1000x700 viewport inside a 1000x562 frame: the page is scaled to 803x562 and centred (bars left and right)
    const [m] = clickMarks([ev(T0 + 1000, { pos: { x: 0.5, y: 0.5 }, vp: { w: 1000, h: 700 } })], clock, 10000, { w: 1000, h: 562 });
    expect(m.x).toBeCloseTo(0.5, 6);
    expect(m.y).toBeCloseTo(0.5, 6);
    const [l] = clickMarks([ev(T0 + 1000, { pos: { x: 0, y: 0 }, vp: { w: 1000, h: 700 } })], clock, 10000, { w: 1000, h: 562 });
    expect(l.x * 1000).toBeCloseTo((1000 - 1000 * (562 / 700)) / 2, 3);
    expect(l.y).toBe(0);
  });
  it('treats a click without a viewport size (older recordings) as filling the frame', () => {
    const [m] = clickMarks([ev(T0 + 1000, { pos: { x: 0.2, y: 0.7 } })], clock, 10000, { w: 1000, h: 562 });
    expect(m).toEqual({ atMs: 1000, x: 0.2, y: 0.7 });
  });
});
