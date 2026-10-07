// Canvas renderer for annotations, shared by the editor preview and the export flattening.
// "Blur" is a coarse mosaic computed from the ORIGINAL image (not reversible); "Redact" is a solid box.
import { bbox, textPx, type Annotation } from '../shared/annotations';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const lineWidth = (w: number) => Math.max(3, Math.round(w * 0.0035));
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

export function mosaic(ctx: Ctx, src: CanvasImageSource, x: number, y: number, w: number, h: number): void {
  if (w < 1 || h < 1) return;
  const block = Math.max(14, Math.round(Math.min(w, h) / 5));
  const sw = Math.max(1, Math.ceil(w / block)), sh = Math.max(1, Math.ceil(h / block));
  const tiny = new OffscreenCanvas(sw, sh);
  const t = tiny.getContext('2d')!;
  t.imageSmoothingEnabled = true;
  t.drawImage(src, x, y, w, h, 0, 0, sw, sh); // averaging downscale
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tiny, 0, 0, sw, sh, x, y, w, h); // blocky upscale
  ctx.restore();
}

function arrowHead(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, size: number): void {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(ang - Math.PI / 7), y2 - size * Math.sin(ang - Math.PI / 7));
  ctx.lineTo(x2 - size * Math.cos(ang + Math.PI / 7), y2 - size * Math.sin(ang + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

export function drawAnnotations(ctx: Ctx, img: CanvasImageSource, w: number, h: number, list: Annotation[], opts: { selectedId?: string | null; handles?: boolean } = {}): void {
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const lw = lineWidth(w);
  for (const a of list) {
    const x1 = a.x1 * w, y1 = a.y1 * h, x2 = a.x2 * w, y2 = a.y2 * h;
    const b = bbox(a);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    ctx.lineWidth = lw;
    switch (a.type) {
      case 'blur':
        mosaic(ctx, img, b.x * w, b.y * h, b.w * w, b.h * h);
        break;
      case 'redact':
        ctx.fillStyle = '#000';
        ctx.fillRect(b.x * w, b.y * h, b.w * w, b.h * h);
        break;
      case 'rect':
        ctx.strokeRect(b.x * w, b.y * h, b.w * w, b.h * h);
        break;
      case 'ellipse':
        ctx.beginPath();
        ctx.ellipse((b.x + b.w / 2) * w, (b.y + b.h / 2) * h, Math.max(1, (b.w * w) / 2), Math.max(1, (b.h * h) / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'line':
      case 'arrow':
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        if (a.type === 'arrow') arrowHead(ctx, x1, y1, x2, y2, lw * 5);
        break;
      case 'text': {
        const f = textPx(h);
        ctx.font = `600 ${f}px Inter, system-ui, sans-serif`;
        ctx.textBaseline = 'top';
        const lines = (a.text ?? '').split('\n');
        const tw = Math.max(...lines.map((l) => ctx.measureText(l).width), 1);
        const padX = f * 0.4, padY = f * 0.2, lh = f * 1.35;
        ctx.fillStyle = a.color;
        ctx.beginPath();
        ctx.roundRect(x1, y1, tw + padX * 2, lines.length * lh + padY * 2, f * 0.3);
        ctx.fill();
        ctx.fillStyle = luminance(a.color) > 0.6 ? '#111827' : '#ffffff';
        lines.forEach((l, i) => ctx.fillText(l, x1 + padX, y1 + padY + i * lh + (lh - f) / 2));
        break;
      }
    }
    ctx.restore();
    if (opts.handles && a.id === opts.selectedId) {
      ctx.save();
      ctx.strokeStyle = '#3b82f6';
      ctx.fillStyle = '#fff';
      ctx.lineWidth = Math.max(2, w * 0.0018);
      ctx.setLineDash([8, 6]);
      if (a.type !== 'line' && a.type !== 'arrow' && a.type !== 'text') ctx.strokeRect(b.x * w, b.y * h, b.w * w, b.h * h);
      ctx.setLineDash([]);
      if (a.type !== 'text') for (const [px, py] of [[x1, y1], [x2, y2]]) {
        ctx.beginPath();
        ctx.arc(px, py, Math.max(6, w * 0.0065), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}

/** Flatten the original image + annotation layer into a PNG derivative (the original is untouched). */
export async function flatten(original: Blob, list: Annotation[]): Promise<Uint8Array> {
  const bmp = await createImageBitmap(original);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  drawAnnotations(c.getContext('2d')!, bmp, bmp.width, bmp.height, list);
  bmp.close();
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
