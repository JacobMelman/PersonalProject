// Video privacy edits (spec B0.16 / 11.5): time-ranged mask regions and cut-out ranges. Times are media time in ms (0 = first frame of the replay).
export interface VideoMask {
  id: string;
  type: 'blur' | 'redact';
  x1: number; y1: number; x2: number; y2: number; // normalised 0..1
  fromMs: number;
  toMs: number;
}
export interface Cut { id: string; fromMs: number; toMs: number }
export interface VideoEdits { masks: VideoMask[]; cuts: Cut[] }
export const emptyEdits = (): VideoEdits => ({ masks: [], cuts: [] });
export const hasEdits = (e: VideoEdits | undefined): boolean => !!e && (e.masks.length > 0 || e.cuts.length > 0);

let n = 0;
export const editId = (p: string) => `${p}_${Date.now().toString(36)}${(n++).toString(36)}`;

/** Merge overlapping cut ranges and sort them. */
export function normalizeCuts(cuts: Cut[]): Array<{ fromMs: number; toMs: number }> {
  const sorted = cuts.filter((c) => c.toMs > c.fromMs).map((c) => ({ fromMs: c.fromMs, toMs: c.toMs })).sort((a, b) => a.fromMs - b.fromMs);
  const out: Array<{ fromMs: number; toMs: number }> = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, c.toMs);
    else out.push({ ...c });
  }
  return out;
}
export const inCut = (ms: number, cuts: Array<{ fromMs: number; toMs: number }>) => cuts.some((c) => ms >= c.fromMs && ms < c.toMs);
/** Output time of a frame once every earlier cut range has been removed. */
export function afterCuts(ms: number, cuts: Array<{ fromMs: number; toMs: number }>): number {
  let removed = 0;
  for (const c of cuts) {
    if (c.toMs <= ms) removed += c.toMs - c.fromMs;
    else if (c.fromMs < ms) removed += ms - c.fromMs;
  }
  return ms - removed;
}
export const activeMasks = (masks: VideoMask[], ms: number) => masks.filter((m) => ms >= m.fromMs && ms < m.toMs);
export const totalCutMs = (cuts: Array<{ fromMs: number; toMs: number }>) => cuts.reduce((a, c) => a + (c.toMs - c.fromMs), 0);

export function sanitizeEdits(raw: unknown, durationMs: number): VideoEdits {
  const r = (raw ?? {}) as Partial<VideoEdits>;
  const clampT = (v: unknown) => Math.max(0, Math.min(durationMs, Number(v) || 0));
  const c01 = (v: unknown) => Math.max(0, Math.min(1, Number(v) || 0));
  return {
    masks: (Array.isArray(r.masks) ? r.masks : []).filter((m) => m && (m.type === 'blur' || m.type === 'redact')).map((m) => ({ id: String(m.id ?? editId('mk')), type: m.type, x1: c01(m.x1), y1: c01(m.y1), x2: c01(m.x2), y2: c01(m.y2), fromMs: clampT(m.fromMs), toMs: clampT(m.toMs) })),
    cuts: (Array.isArray(r.cuts) ? r.cuts : []).map((c) => ({ id: String(c?.id ?? editId('cu')), fromMs: clampT(c?.fromMs), toMs: clampT(c?.toMs) })),
  };
}
