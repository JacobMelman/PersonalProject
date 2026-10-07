// Muxes stored GOP segments into a playable WebM (baseline container; MP4 is a Phase 0 decision point - see docs).
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Output, WebMOutputFormat } from 'mediabunny';
import { readSegment, segmentsOfSession } from '../storage/segments';
import type { SegmentMeta } from '../shared/types';

export interface MuxedVideo {
  blob: Blob;
  startWall: number;
  endWall: number;
  durationMs: number;
  codec: string;
  width: number;
  height: number;
  segments: number;
  gaps: Array<{ fromWall: number; toWall: number }>;
}

/** Latest contiguous run of segments sharing one encoder configuration (a resize changes the track and cannot be muxed in place). */
function latestRun(segs: SegmentMeta[]): SegmentMeta[] {
  if (!segs.length) return [];
  const last = segs[segs.length - 1];
  const run: SegmentMeta[] = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (s.codec !== last.codec || s.width !== last.width || s.height !== last.height) break;
    run.unshift(s);
  }
  return run;
}

export async function muxSessionVideo(sessionId: string, fromWall = 0): Promise<MuxedVideo | null> {
  const all = (await segmentsOfSession(sessionId)).filter((s) => s.endWall > fromWall);
  const run = latestRun(all);
  if (!run.length) return null;
  const first = run[0];
  const baseUs = first.startWall * 1000;
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const codec = first.codec.startsWith('vp09') ? 'vp9' : 'vp8';
  const source = new EncodedVideoPacketSource(codec);
  output.addVideoTrack(source);
  await output.start();
  let sentConfig = false;
  const gaps: MuxedVideo['gaps'] = [];
  let prevEnd = first.startWall;
  let lastEnd = first.endWall;
  for (const seg of run) {
    if (seg.startWall - prevEnd > 1500) gaps.push({ fromWall: prevEnd, toWall: seg.startWall });
    prevEnd = seg.endWall;
    lastEnd = seg.endWall;
    for (const c of await readSegment(seg.id)) {
      const packet = new EncodedPacket(c.data.slice(), c.key ? 'key' : 'delta', (c.timestampUs - baseUs) / 1e6, Math.max(c.durationUs, 1) / 1e6);
      await source.add(packet, sentConfig ? undefined : { decoderConfig: { codec: first.codec, codedWidth: first.width, codedHeight: first.height } });
      sentConfig = true;
    }
  }
  await output.finalize();
  const buf = (output.target as BufferTarget).buffer!;
  return {
    blob: new Blob([buf], { type: 'video/webm' }),
    startWall: first.startWall,
    endWall: lastEnd,
    durationMs: lastEnd - first.startWall,
    codec: first.codec,
    width: first.width,
    height: first.height,
    segments: run.length,
    gaps,
  };
}
