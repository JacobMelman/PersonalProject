import { describe, expect, it } from 'vitest';
import { deletable, pin, selectEvictable, selectWindow, unpin } from '../../src/shared/ring';
import type { SegmentMeta } from '../../src/shared/types';

const seg = (id: string, start: number, end: number, extra: Partial<SegmentMeta> = {}): SegmentMeta => ({
  id, startWall: start, endWall: end, bytes: 1000, chunkCount: 30, codec: 'vp8', width: 1280, height: 720, refs: [], ...extra,
});

describe('ring retention', () => {
  const segs = Array.from({ length: 10 }, (_, i) => seg(`s${i}`, i * 2000, i * 2000 + 2000));
  it('evicts only temporary segments older than retention', () => {
    const ev = selectEvictable(segs, 20000, 10000);
    expect(ev.map((s) => s.id)).toEqual(['s0', 's1', 's2', 's3']);
  });
  it('never evicts pinned segments (saved evidence outranks temporary evidence)', () => {
    const pinned = segs.map((s, i) => (i < 3 ? pin(s, 'sess1') : s));
    expect(selectEvictable(pinned, 20000, 10000).map((s) => s.id)).toEqual(['s3']);
  });
  it('after a long pause the ring may be empty (aging does not freeze)', () => {
    expect(selectEvictable(segs, 10 * 3600 * 1000, 90000)).toHaveLength(10);
  });
});

describe('selectWindow', () => {
  const segs = Array.from({ length: 10 }, (_, i) => seg(`s${i}`, i * 2000, i * 2000 + 2000));
  it('selects pre-window plus tail', () => {
    const w = selectWindow(segs, 16000, 6000, 18000);
    expect(w.map((s) => s.id)).toEqual(['s5', 's6', 's7', 's8']);
  });
  it('keeps only the latest run with one encoder configuration', () => {
    const mixed = [seg('a', 0, 2000), seg('b', 2000, 4000, { width: 800 }), seg('c', 4000, 6000, { width: 800 })];
    expect(selectWindow(mixed, 6000, 10000, 6000).map((s) => s.id)).toEqual(['b', 'c']);
  });
  it('returns nothing for an empty ring', () => {
    expect(selectWindow([], 1000, 1000, 2000)).toEqual([]);
  });
});

describe('reference-aware cleanup', () => {
  it('pin/unpin tracks references', () => {
    let s = seg('x', 0, 1);
    expect(deletable(s)).toBe(true);
    s = pin(pin(s, 'a'), 'b');
    expect(deletable(s)).toBe(false);
    s = unpin(s, 'a');
    expect(deletable(s)).toBe(false);
    s = unpin(s, 'b');
    expect(deletable(s)).toBe(true);
  });
});
