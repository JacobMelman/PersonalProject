// Re-renders the replay with privacy edits applied: masked regions (mosaic / black box) over time ranges, and cut-out ranges.
// Decode (WebCodecs) -> draw -> mask -> re-encode -> mux. The stored original segments are never modified.
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Output, WebMOutputFormat } from 'mediabunny';
import { readSegment } from '../storage/segments';
import { selectRun } from './video';
import { mosaic } from '../ui/annotate-render';
import { activeMasks, afterCuts, inCut, normalizeCuts, type VideoEdits } from '../shared/video-edits';
import { buildClock, wallToVideoMs, type VideoPause } from '../shared/video-clock';
import { drawPauseCard } from './pause-card';
import { clickTicks, drawClicks, type ClickMark } from '../shared/click-marks';

export interface EditedVideo {
  blob: Blob;
  durationMs: number;
  frames: number;
  width: number;
  height: number;
  codec: string;
}


export async function renderEditedVideo(
  sessionId: string,
  edits: VideoEdits,
  opts: { fromWall?: number; bitrateKbps?: number; fps?: number; clicks?: ClickMark[]; onProgress?: (fraction: number) => void } = {},
): Promise<EditedVideo | null> {
  const run = await selectRun(sessionId, opts.fromWall ?? 0);
  if (!run.length) return null;
  const first = run[0];
  const W = first.width, H = first.height;
  const clock = buildClock(run); // same time base as the player: pauses are collapsed to a card
  let nextPause = 0;
  const cuts = normalizeCuts(edits.cuts);
  const canvas = new OffscreenCanvas(W, H); // what is encoded: the last decoded frame + masks + click highlights
  // CPU-backed canvases: every frame is read back by the encoder (and by the mosaic); with a GPU-backed canvas that readback
  // dominated the export on machines without a fast GPU
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const raw = new OffscreenCanvas(W, H); // the last decoded frame as recorded
  const rctx = raw.getContext('2d', { willReadFrequently: true })!;
  let hasRaw = false;
  const marks = opts.clicks ?? [];
  const ticks = clickTicks(marks);
  let nextTick = 0;
  let lastRel = -1e9;

  // 'realtime' like the recording itself: 'quality' made a long or busy replay take minutes to export for no visible gain
  const cfg: VideoEncoderConfig = { codec: first.codec, width: W, height: H, bitrate: (opts.bitrateKbps ?? 1500) * 1000, framerate: opts.fps ?? 15, latencyMode: 'realtime', bitrateMode: 'variable' };
  if (!(await VideoEncoder.isConfigSupported(cfg)).supported) throw new Error(`The browser cannot encode ${first.codec}`);

  const packets: Array<{ packet: EncodedPacket; decoderConfig?: VideoDecoderConfig }> = [];
  let frames = 0, lastKeyMs = -1e9, lastOutMs = -1e9, endMs = 0, fatal: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({ packet: new EncodedPacket(data, chunk.type === 'key' ? 'key' : 'delta', chunk.timestamp / 1e6, Math.max(1, chunk.duration ?? 66_000) / 1e6), decoderConfig: meta?.decoderConfig as VideoDecoderConfig | undefined });
    },
    error: (e) => { fatal = new Error(`Encoder: ${e.message}`); },
  });
  encoder.configure(cfg);

  const emit = (outMs: number, durUs: number) => {
    const key = outMs - lastKeyMs >= 2000 || outMs - lastOutMs > 1500 || frames === 0;
    if (key) lastKeyMs = outMs;
    const vf = new VideoFrame(canvas, { timestamp: Math.round(outMs * 1000), duration: durUs });
    encoder.encode(vf, { keyFrame: key });
    vf.close();
    lastOutMs = outMs;
    endMs = outMs + durUs / 1000;
    frames++;
  };
  // Every encoded frame is composed afresh, so a mask that starts between two recorded frames also covers the in-between ones.
  const compose = (t: number) => {
    ctx.drawImage(raw, 0, 0);
    for (const m of activeMasks(edits.masks, t)) {
      const x = Math.min(m.x1, m.x2) * W, y = Math.min(m.y1, m.y2) * H, w = Math.abs(m.x2 - m.x1) * W, h = Math.abs(m.y2 - m.y1) * H;
      if (m.type === 'redact') { ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h); } else mosaic(ctx, canvas, x, y, w, h);
    }
    drawClicks(ctx, W, H, marks, t);
  };
  const inCard = (t: number) => clock.pauses.some((p) => t >= p.atMs && t < p.atMs + p.holdMs);
  // A still page sends no frames, so a highlight needs frames of its own to animate and to disappear again.
  const flushTicks = (until: number) => {
    while (nextTick < ticks.length && ticks[nextTick] < until) {
      const t = ticks[nextTick++];
      if (!hasRaw || t <= lastRel || inCut(t, cuts) || inCard(t)) continue;
      compose(t);
      emit(afterCuts(t, cuts), Math.max(1, Math.min(ticks[nextTick] ?? until, until) - t) * 1000);
      lastRel = t;
    }
  };
  const card = (p: VideoPause) => {
    flushTicks(p.atMs);
    if (inCut(p.atMs, cuts)) return;
    drawPauseCard(ctx, W, H, p);
    emit(afterCuts(p.atMs, cuts), p.holdMs * 1000);
    lastRel = p.atMs;
  };

  let lastFrameEnd = 0;
  const decoder = new VideoDecoder({
    output: (frame) => {
      const relMs = wallToVideoMs(clock, frame.timestamp / 1000);
      while (nextPause < clock.pauses.length && relMs >= clock.pauses[nextPause].atMs + clock.pauses[nextPause].holdMs) card(clock.pauses[nextPause++]);
      flushTicks(relMs);
      if (inCut(relMs, cuts)) { frame.close(); return; } // never kept, not even as the picture behind a later highlight
      rctx.drawImage(frame, 0, 0, W, H);
      hasRaw = true;
      const dur = frame.duration ?? 66_000;
      frame.close();
      compose(relMs);
      emit(afterCuts(relMs, cuts), dur);
      lastRel = relMs;
      lastFrameEnd = relMs + dur / 1000;
    },
    error: (e) => { fatal = new Error(`Decoder: ${e.message}`); },
  });
  decoder.configure({ codec: first.codec, codedWidth: W, codedHeight: H });

  const total = run.reduce((a, s) => a + s.chunkCount, 0) || 1;
  let done = 0;
  for (const seg of run) {
    for (const c of await readSegment(seg.id)) {
      if (fatal) throw fatal;
      decoder.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: c.timestampUs, duration: c.durationUs, data: c.data }));
      // back-pressure on the codecs' own events: timers are throttled to once a second in a background tab, which made an
      // export crawl when the Review tab was not in front
      while (!fatal && (decoder.decodeQueueSize > 6 || encoder.encodeQueueSize > 12)) {
        await new Promise<void>((r) => {
          const t = decoder.decodeQueueSize > 6 ? decoder : encoder;
          t.addEventListener('dequeue', () => r(), { once: true });
          setTimeout(r, 500); // never hang if a codec stops (an error is reported through `fatal`)
        });
      }
      if (++done % 30 === 0) opts.onProgress?.(done / total);
    }
  }
  await decoder.flush();
  flushTicks(lastFrameEnd);
  await encoder.flush();
  decoder.close();
  encoder.close();
  if (fatal) throw fatal;
  if (!packets.length) return null;

  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const source = new EncodedVideoPacketSource(first.codec.startsWith('vp09') ? 'vp9' : 'vp8');
  output.addVideoTrack(source);
  await output.start();
  let sent = false;
  for (const p of packets) {
    await source.add(p.packet, !sent ? { decoderConfig: { codec: first.codec, codedWidth: W, codedHeight: H } } : undefined);
    sent = true;
  }
  await output.finalize();
  opts.onProgress?.(1);
  return { blob: new Blob([(output.target as BufferTarget).buffer!], { type: 'video/webm' }), durationMs: endMs, frames, width: W, height: H, codec: first.codec };
}
