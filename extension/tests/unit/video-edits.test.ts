import { describe, expect, it } from 'vitest';
import { activeMasks, afterCuts, inCut, normalizeCuts, sanitizeEdits, totalCutMs, hasEdits, emptyEdits } from '../../src/shared/video-edits';

describe('video edits', () => {
  it('merges overlapping cuts and drops empty ones', () => {
    const n = normalizeCuts([{ id: 'a', fromMs: 5000, toMs: 8000 }, { id: 'b', fromMs: 7000, toMs: 9000 }, { id: 'c', fromMs: 1000, toMs: 2000 }, { id: 'd', fromMs: 3000, toMs: 3000 }]);
    expect(n).toEqual([{ fromMs: 1000, toMs: 2000 }, { fromMs: 5000, toMs: 9000 }]);
    expect(totalCutMs(n)).toBe(5000);
  });
  it('maps media time after removing cuts', () => {
    const cuts = [{ fromMs: 1000, toMs: 2000 }, { fromMs: 5000, toMs: 9000 }];
    expect(afterCuts(500, cuts)).toBe(500);
    expect(afterCuts(2500, cuts)).toBe(1500);
    expect(afterCuts(9500, cuts)).toBe(4500);
    expect(inCut(1500, cuts)).toBe(true);
    expect(inCut(2000, cuts)).toBe(false);
  });
  it('selects masks active at a time', () => {
    const m = [{ id: '1', type: 'blur' as const, x1: 0, y1: 0, x2: 1, y2: 1, fromMs: 1000, toMs: 3000 }, { id: '2', type: 'redact' as const, x1: 0, y1: 0, x2: 1, y2: 1, fromMs: 2000, toMs: 4000 }];
    expect(activeMasks(m, 500)).toHaveLength(0);
    expect(activeMasks(m, 2500)).toHaveLength(2);
    expect(activeMasks(m, 3500).map((x) => x.id)).toEqual(['2']);
  });
  it('sanitises stored edits', () => {
    const e = sanitizeEdits({ masks: [{ type: 'blur', x1: -1, y1: 0, x2: 3, y2: 1, fromMs: -5, toMs: 99999 }, { type: 'evil' }], cuts: [{ fromMs: 10, toMs: 20 }] }, 5000);
    expect(e.masks).toHaveLength(1);
    expect(e.masks[0]).toMatchObject({ x1: 0, x2: 1, fromMs: 0, toMs: 5000 });
    expect(e.cuts).toHaveLength(1);
    expect(hasEdits(e)).toBe(true);
    expect(hasEdits(emptyEdits())).toBe(false);
  });
});
