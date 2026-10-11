// Muxes stored GOP segments into a playable WebM (baseline container; MP4 is a Phase 0 decision point - see docs).
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Output, WebMOutputFormat } from 'mediabunny';
import { readSegment, segmentsOfSession } from '../storage/segments';
import type { SegmentMeta } from '../shared/types';
import { buildClock, wallToVideoMs, type VideoClock } from '../shared/video-clock';
import { encodePauseCard } from './pause-card';

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
  /** Maps wall-clock time to video time; capture pauses are collapsed to a short "not recorded" card. */
  clock: VideoClock;
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

/** Segments of the replay (latest contiguous run with one encoder configuration), optionally dropping everything before `fromWall`. */
export async function selectRun(sessionId: string, fromWall = 0): Promise<SegmentMeta[]> {
  return latestRun((await segmentsOfSession(sessionId)).filter((s) => s.endWall > fromWall));
}

export async function muxSessionVideo(sessionId: string, fromWall = 0): Promise<MuxedVideo | null> {
  const run = await selectRun(sessionId, fromWall);
  if (!run.length) return null;
  const first = run[0];
  const clock = buildClock(run);
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
    const pause = clock.pauses.find((p) => p.toWall === seg.startWall);
    const card = pause && sentConfig ? await encodePauseCard(first.codec, first.width, first.height, pause) : null;
    if (pause && card) await source.add(new EncodedPacket(card, 'key', pause.atMs / 1000, pause.holdMs / 1000));
    for (const c of await readSegment(seg.id)) {
      const packet = new EncodedPacket(c.data.slice(), c.key ? 'key' : 'delta', wallToVideoMs(clock, c.timestampUs / 1000) / 1000, Math.max(c.durationUs, 1) / 1e6);
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
    durationMs: wallToVideoMs(clock, lastEnd),
    codec: first.codec,
    width: first.width,
    height: first.height,
    segments: run.length,
    gaps,
    clock,
  };
}
