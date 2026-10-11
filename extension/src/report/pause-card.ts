// The "not recorded" card a replay shows in place of a capture pause (see shared/video-clock.ts).
// It says what happened, not for how long: how long someone was away from the tab is nobody's business.
import { pauseLabel, type VideoPause } from '../shared/video-clock';

export function drawPauseCard(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, p: VideoPause): void {
  ctx.fillStyle = '#0E1A2B';
  ctx.fillRect(0, 0, w, h);
  const s = Math.max(12, Math.round(h / 20));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FBFBFD';
  ctx.font = `700 ${Math.round(s * 1.4)}px Inter, Arial, sans-serif`;
  ctx.fillText(`${pauseLabel(p.reason)} · not recorded`, w / 2, h / 2);
}

/** One key frame of the card, encoded with the replay's own codec and size so it can sit between its packets. */
export async function encodePauseCard(codec: string, w: number, h: number, p: VideoPause): Promise<Uint8Array | null> {
  try {
    const canvas = new OffscreenCanvas(w, h);
    drawPauseCard(canvas.getContext('2d')!, w, h, p);
    let data: Uint8Array | null = null;
    const enc = new VideoEncoder({
      output: (chunk) => {
        data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
      },
      error: () => undefined,
    });
    enc.configure({ codec, width: w, height: h, bitrate: 400_000, framerate: 10 });
    const frame = new VideoFrame(canvas, { timestamp: 0 });
    enc.encode(frame, { keyFrame: true });
    frame.close();
    await enc.flush();
    enc.close();
    return data;
  } catch {
    return null; // no card: the pause is still collapsed, the last frame simply holds for the card's time
  }
}
