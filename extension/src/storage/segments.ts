// Segment = one GOP of encoded video chunks. Binary layout per record:
//   u8 isKey | f64 timestampUs | f64 durationUs | u32 byteLength | bytes
import { dbDelete, dbGet, dbGetAll, dbPut, dbPutMany, dbIndexAll } from './db';
import { opfsRead, opfsRemove, opfsWrite } from './opfs';
import { deletable, pin, selectEvictable, selectWindow } from '../shared/ring';
import type { SegmentMeta } from '../shared/types';

export interface StoredChunk {
  key: boolean;
  timestampUs: number;
  durationUs: number;
  data: Uint8Array;
}

export const segPath = (id: string) => `seg/${id}.bin`;

export function encodeSegment(chunks: StoredChunk[]): Blob {
  const parts: BlobPart[] = [];
  for (const c of chunks) {
    const head = new ArrayBuffer(21);
    const v = new DataView(head);
    v.setUint8(0, c.key ? 1 : 0);
    v.setFloat64(1, c.timestampUs);
    v.setFloat64(9, c.durationUs);
    v.setUint32(17, c.data.byteLength);
    parts.push(head, c.data as BlobPart);
  }
  return new Blob(parts);
}

export function decodeSegment(buf: ArrayBuffer): StoredChunk[] {
  const v = new DataView(buf);
  const out: StoredChunk[] = [];
  let o = 0;
  while (o + 21 <= buf.byteLength) {
    const len = v.getUint32(o + 17);
    if (o + 21 + len > buf.byteLength) break; // truncated tail is dropped, earlier chunks stay valid
    out.push({
      key: v.getUint8(o) === 1,
      timestampUs: v.getFloat64(o + 1),
      durationUs: v.getFloat64(o + 9),
      data: new Uint8Array(buf, o + 21, len),
    });
    o += 21 + len;
  }
  return out;
}

export async function commitSegment(meta: SegmentMeta, chunks: StoredChunk[]): Promise<void> {
  const blob = encodeSegment(chunks);
  await opfsWrite(segPath(meta.id), blob); // media first ...
  await dbPut('segments', { ...meta, bytes: blob.size }); // ... then the index entry: an indexed segment is always readable
}

export async function readSegment(id: string): Promise<StoredChunk[]> {
  const f = await opfsRead(segPath(id));
  return decodeSegment(await f.arrayBuffer());
}

export const listSegments = () => dbGetAll<SegmentMeta>('segments');

export async function segmentsOfSession(sessionId: string): Promise<SegmentMeta[]> {
  const all = await listSegments();
  return all.filter((s) => s.refs.includes(sessionId)).sort((a, b) => a.startWall - b.startWall);
}

export async function cleanupRing(now: number, retentionMs: number): Promise<{ removed: number; ringBytes: number; ringSegments: number }> {
  const all = await listSegments();
  const evict = selectEvictable(all, now, retentionMs);
  for (const s of evict) {
    await dbDelete('segments', s.id);
    await opfsRemove(segPath(s.id));
  }
  const keep = all.filter((s) => !evict.includes(s) && s.refs.length === 0);
  return { removed: evict.length, ringBytes: keep.reduce((a, s) => a + s.bytes, 0), ringSegments: keep.length };
}

/** Pin the window of ring segments to a session (no media is copied - only the reference is added). */
export async function pinWindow(sessionId: string, triggerWall: number, preMs: number, tailEndWall: number): Promise<SegmentMeta[]> {
  const win = selectWindow(await listSegments(), triggerWall, preMs, tailEndWall);
  const pinned = win.map((s) => pin(s, sessionId));
  await dbPutMany('segments', pinned);
  return pinned;
}

export async function unpinSession(sessionId: string): Promise<void> {
  const mine = await segmentsOfSession(sessionId);
  for (const s of mine) {
    const next = { ...s, refs: s.refs.filter((r) => r !== sessionId) };
    if (deletable(next)) {
      await dbDelete('segments', s.id);
      await opfsRemove(segPath(s.id));
    } else {
      await dbPut('segments', next);
    }
  }
}

export async function getSegment(id: string) {
  return dbGet<SegmentMeta>('segments', id);
}

export async function segmentsByEndRange(from: number): Promise<SegmentMeta[]> {
  return dbIndexAll<SegmentMeta>('segments', 'endWall', IDBKeyRange.lowerBound(from));
}
