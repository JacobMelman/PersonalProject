import type { SegmentMeta } from './types';

const sameConfig = (a: SegmentMeta, b: SegmentMeta) => a.codec === b.codec && a.width === b.width && a.height === b.height;

/** Temporary ring segments that aged out of the rolling window and are not pinned by any session. */
export function selectEvictable(segments: SegmentMeta[], now: number, retentionMs: number): SegmentMeta[] {
  return segments.filter((s) => s.refs.length === 0 && s.endWall < now - retentionMs);
}

/**
 * Segments that must be pinned for a "Save last replay": everything overlapping [trigger - pre, tailEnd], restricted to the
 * most recent run that shares one encoder configuration (a resolution change cannot be muxed into the same track).
 */
export function selectWindow(segments: SegmentMeta[], triggerWall: number, preMs: number, tailEndWall: number): SegmentMeta[] {
  const sorted = segments
    .filter((s) => s.endWall > triggerWall - preMs && s.startWall < tailEndWall)
    .sort((a, b) => a.startWall - b.startWall);
  if (!sorted.length) return [];
  const last = sorted[sorted.length - 1];
  const out: SegmentMeta[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (!sameConfig(sorted[i], last)) break;
    out.unshift(sorted[i]);
  }
  return out;
}

export function pin(seg: SegmentMeta, sessionId: string): SegmentMeta {
  return seg.refs.includes(sessionId) ? seg : { ...seg, refs: [...seg.refs, sessionId] };
}

export function unpin(seg: SegmentMeta, sessionId: string): SegmentMeta {
  return { ...seg, refs: seg.refs.filter((r) => r !== sessionId) };
}

/** Reference-aware cleanup: a segment may be deleted only when nothing references it any more. */
export function deletable(seg: SegmentMeta): boolean {
  return seg.refs.length === 0;
}
