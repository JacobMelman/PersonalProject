// Click highlights on the replay: a ring that expands and fades where the user clicked. They are drawn from the click positions
// the timeline already stores (never by touching the tested page), over the player in Review and into exported copies;
// the stored recording itself is never changed.
import type { TimelineEvent } from './types';
import { wallToVideoMs, type VideoClock } from './video-clock';

/** How long one highlight stays on screen. */
export const CLICK_MARK_MS = 800;
const COLOR = '255, 90, 78'; // ReproDesk red

export interface ClickMark {
  /** Milliseconds into the video (the player's clock). */
  atMs: number;
  /** Position in the frame, 0..1. */
  x: number;
  y: number;
}

/**
 * Clicks of the top document that fall inside the video (an iframe reports positions in its own box, so it is left out).
 * Tab capture keeps the aspect ratio it started with: when the viewport changes shape later, the page is fitted into the frame
 * with bars, so the position is mapped through that fit (`frame` = the video's size; clicks without a viewport size, from
 * older recordings, are taken as filling the frame).
 */
export function clickMarks(events: TimelineEvent[], clock: VideoClock, durationMs: number, frame?: { w: number; h: number }): ClickMark[] {
  const place = (e: TimelineEvent) => {
    const { x, y } = e.pos!;
    if (!frame || !e.vp || e.vp.w <= 0 || e.vp.h <= 0) return { x, y };
    const s = Math.min(frame.w / e.vp.w, frame.h / e.vp.h);
    const cw = e.vp.w * s, ch = e.vp.h * s;
    return { x: ((frame.w - cw) / 2 + x * cw) / frame.w, y: ((frame.h - ch) / 2 + y * ch) / frame.h };
  };
  return events
    .filter((e) => e.type === 'click' && e.pos && !e.frame)
    .map((e) => ({ atMs: wallToVideoMs(clock, e.ts), ...place(e) }))
    .filter((m) => m.atMs >= 0 && m.atMs <= durationMs && m.x >= 0 && m.x <= 1 && m.y >= 0 && m.y <= 1)
    .sort((a, b) => a.atMs - b.atMs);
}

export function activeClicks(marks: ClickMark[], tMs: number): ClickMark[] {
  return marks.filter((m) => tMs >= m.atMs && tMs < m.atMs + CLICK_MARK_MS);
}

/** Moments a re-encoder must show while highlights animate (the page may send no frames then), ending with a clean frame. */
export function clickTicks(marks: ClickMark[], stepMs = 80): number[] {
  const t = new Set<number>();
  for (const m of marks) {
    for (let s = 0; s < CLICK_MARK_MS; s += stepMs) t.add(Math.round(m.atMs + s));
    t.add(Math.round(m.atMs + CLICK_MARK_MS));
  }
  return [...t].sort((a, b) => a - b);
}

/** Draws the highlights visible at `tMs` on a canvas the size of the video frame (or of the player's picture). */
export function drawClicks(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number, marks: ClickMark[], tMs: number): void {
  const base = Math.max(16, Math.min(w, h) * 0.055);
  for (const m of activeClicks(marks, tMs)) {
    const k = (tMs - m.atMs) / CLICK_MARK_MS; // 0 -> 1
    const x = m.x * w, y = m.y * h, fade = 1 - k;
    const r = base * (0.6 + 1.0 * k);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${COLOR}, ${0.38 * fade})`;
    ctx.fill();
    ctx.lineWidth = Math.max(2.5, base * 0.2);
    ctx.strokeStyle = `rgba(${COLOR}, ${0.95 * fade})`;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2.5, base * 0.18), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${COLOR}, ${fade})`;
    ctx.fill();
    ctx.restore();
  }
}
