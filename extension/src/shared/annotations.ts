// Non-destructive screenshot annotations (spec 7.15, 13.9, REP-11). Geometry is normalised to the image (0..1), so it is
// independent of resolution; the original screenshot is never modified, exports render a flattened derivative.
export type AnnotationType = 'arrow' | 'line' | 'rect' | 'ellipse' | 'text' | 'blur' | 'redact';

export interface Annotation {
  id: string;
  type: AnnotationType;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  text?: string;
}

export const COLORS = ['#ff3b4e', '#ffb020', '#22c55e', '#3b82f6', '#111827', '#ffffff'] as const;
export const isRedaction = (a: Annotation) => a.type === 'blur' || a.type === 'redact';
export const hasRedaction = (list: Annotation[] | undefined) => !!list?.some(isRedaction);
export const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

let seq = 0;
export const newAnnotationId = () => `an_${Date.now().toString(36)}${(seq++).toString(36)}`;

export function make(type: AnnotationType, x1: number, y1: number, x2: number, y2: number, color: string, text?: string): Annotation {
  return { id: newAnnotationId(), type, x1: clamp01(x1), y1: clamp01(y1), x2: clamp01(x2), y2: clamp01(y2), color, ...(text !== undefined ? { text } : {}) };
}

export const bbox = (a: Annotation) => ({ x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) });

/** Font size in image pixels used for text annotations (also by the renderer, so hit boxes match what is drawn). */
export const textPx = (imgH: number) => Math.max(16, Math.round(imgH * 0.028));
export function textBox(a: Annotation, w: number, h: number) {
  const f = textPx(h);
  const lines = (a.text ?? '').split('\n');
  const width = Math.max(...lines.map((l) => l.length), 1) * f * 0.58 + f * 0.8;
  return { x: a.x1 * w, y: a.y1 * h, w: width, h: lines.length * f * 1.35 + f * 0.4 };
}

export type Hit = 'body' | 'p1' | 'p2' | null;

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Hit-test in image pixels. Handles (end points) win over the body so shapes can be resized. */
export function hit(a: Annotation, nx: number, ny: number, w: number, h: number, tol = 10): Hit {
  const px = nx * w, py = ny * h;
  if (a.type === 'text') {
    const b = textBox(a, w, h);
    return px >= b.x - tol && px <= b.x + b.w + tol && py >= b.y - tol && py <= b.y + b.h + tol ? 'body' : null;
  }
  if (Math.hypot(px - a.x1 * w, py - a.y1 * h) <= tol * 1.4) return 'p1';
  if (Math.hypot(px - a.x2 * w, py - a.y2 * h) <= tol * 1.4) return 'p2';
  if (a.type === 'arrow' || a.type === 'line') return distToSegment(px, py, a.x1 * w, a.y1 * h, a.x2 * w, a.y2 * h) <= tol ? 'body' : null;
  const b = bbox(a);
  return px >= b.x * w - tol && px <= (b.x + b.w) * w + tol && py >= b.y * h - tol && py <= (b.y + b.h) * h + tol ? 'body' : null;
}

/** Topmost annotation under the pointer (later items are drawn on top). */
export function pick(list: Annotation[], nx: number, ny: number, w: number, h: number, tol = 10): { index: number; part: Exclude<Hit, null> } | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const part = hit(list[i], nx, ny, w, h, tol);
    if (part) return { index: i, part };
  }
  return null;
}

export function move(a: Annotation, dx: number, dy: number): Annotation {
  const bx = Math.min(a.x1, a.x2), by = Math.min(a.y1, a.y2), ex = Math.max(a.x1, a.x2), ey = Math.max(a.y1, a.y2);
  const cdx = Math.max(-bx, Math.min(1 - ex, dx)), cdy = Math.max(-by, Math.min(1 - ey, dy)); // keep the whole shape inside the image
  return { ...a, x1: a.x1 + cdx, y1: a.y1 + cdy, x2: a.x2 + cdx, y2: a.y2 + cdy };
}
export function movePoint(a: Annotation, part: 'p1' | 'p2', nx: number, ny: number): Annotation {
  return part === 'p1' ? { ...a, x1: clamp01(nx), y1: clamp01(ny) } : { ...a, x2: clamp01(nx), y2: clamp01(ny) };
}

/** Linear undo/redo of whole annotation lists (immutable snapshots). */
export class History {
  private past: Annotation[][] = [];
  private future: Annotation[][] = [];
  constructor(public present: Annotation[] = []) {}
  commit(next: Annotation[]): void {
    if (JSON.stringify(next) === JSON.stringify(this.present)) return;
    this.past.push(this.present);
    this.present = next;
    this.future = [];
  }
  undo(): boolean {
    const p = this.past.pop();
    if (!p) return false;
    this.future.push(this.present);
    this.present = p;
    return true;
  }
  redo(): boolean {
    const n = this.future.pop();
    if (!n) return false;
    this.past.push(this.present);
    this.present = n;
    return true;
  }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}

/** Defensive parse of stored annotations (they come from IndexedDB). */
export function sanitize(raw: unknown): Annotation[] {
  if (!Array.isArray(raw)) return [];
  const types = new Set(['arrow', 'line', 'rect', 'ellipse', 'text', 'blur', 'redact']);
  return raw.filter((r): r is Annotation => !!r && typeof r === 'object' && types.has((r as Annotation).type) && ['x1', 'y1', 'x2', 'y2'].every((k) => Number.isFinite((r as Record<string, number>)[k])))
    .map((r) => ({ id: String(r.id ?? newAnnotationId()), type: r.type, x1: clamp01(r.x1), y1: clamp01(r.y1), x2: clamp01(r.x2), y2: clamp01(r.y2), color: typeof r.color === 'string' ? r.color : COLORS[0], ...(typeof r.text === 'string' ? { text: r.text.slice(0, 200) } : {}) }));
}
