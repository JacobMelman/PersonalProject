// Re-renders the replay with privacy edits applied: masked regions (mosaic / black box) over time ranges, and cut-out ranges.
// Decode (WebCodecs) -> draw -> mask -> re-encode -> mux. The stored original segments are never modified.
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Output, WebMOutputFormat } from 'mediabunny';
import { readSegment } from '../storage/segments';
import { selectRun } from './video';
import { mosaic } from '../ui/annotate-render';
import { activeMasks, afterCuts, inCut, normalizeCuts, type VideoEdits } from '../shared/video-edits';

export interface EditedVideo {
  blob: Blob;
  durationMs: number;
  frames: number;
  width: number;
  height: number;
  codec: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function renderEditedVideo(
  sessionId: string,
  edits: VideoEdits,
  opts: { fromWall?: number; bitrateKbps?: number; fps?: number; onProgress?: (fraction: number) => void } = {},
): Promise<EditedVideo | null> {
  const run = await selectRun(sessionId, opts.fromWall ?? 0);
  if (!run.length) return null;
  const first = run[0];
  const W = first.width, H = first.height;
  const baseUs = first.startWall * 1000;
  const cuts = normalizeCuts(edits.cuts);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!;

  const cfg: VideoEncoderConfig = { codec: first.codec, width: W, height: H, bitrate: (opts.bitrateKbps ?? 1500) * 1000, framerate: opts.fps ?? 15, latencyMode: 'quality', bitrateMode: 'variable' };
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

  const decoder = new VideoDecoder({
    output: (frame) => {
      const relMs = (frame.timestamp - baseUs) / 1000;
      if (inCut(relMs, cuts)) { frame.close(); return; }
      ctx.drawImage(frame, 0, 0, W, H);
      const dur = frame.duration ?? 66_000;
      frame.close();
      for (const m of activeMasks(edits.masks, relMs)) {
        const x = Math.min(m.x1, m.x2) * W, y = Math.min(m.y1, m.y2) * H, w = Math.abs(m.x2 - m.x1) * W, h = Math.abs(m.y2 - m.y1) * H;
        if (m.type === 'redact') { ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h); } else mosaic(ctx, canvas, x, y, w, h);
      }
      const outMs = afterCuts(relMs, cuts);
      const key = outMs - lastKeyMs >= 2000 || outMs - lastOutMs > 1500 || frames === 0;
      if (key) lastKeyMs = outMs;
      const vf = new VideoFrame(canvas, { timestamp: Math.round(outMs * 1000), duration: dur });
      encoder.encode(vf, { keyFrame: key });
      vf.close();
      lastOutMs = outMs;
      endMs = outMs + dur / 1000;
      frames++;
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
      while (decoder.decodeQueueSize > 6 || encoder.encodeQueueSize > 12) await sleep(1);
      if (++done % 30 === 0) opts.onProgress?.(done / total);
    }
  }
  await decoder.flush();
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
