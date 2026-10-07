// "Sample sessions": a pre-recorded, scripted run of a demo shop that can be loaded into the local store, so a reviewer or presenter
// can try the Review page, the redaction tools and every export without recording anything first. Sample data is always labelled
// (SessionRecord.sample) and can be removed again; it never touches real evidence.
import { dbGetAll, dbPut, dbPutMany } from '../storage/db';
import { opfsWrite } from '../storage/opfs';
import { decodeSegment, encodeSegment, segPath } from '../storage/segments';
import type { ReportRecord, ScreenshotItem, SegmentMeta, SessionRecord, TimelineEvent } from '../shared/types';

interface Bundle {
  version: number;
  anchor: number;
  sessions: SessionRecord[];
  events: TimelineEvent[];
  shots: Array<ScreenshotItem & { file: string }>;
  reports: Array<Omit<ReportRecord, 'id' | 'sessionId' | 'updatedAt'> & { sessionKey: string }>;
  segments: Array<SegmentMeta & { file: string }>;
}

const rid = () => Math.random().toString(36).slice(2, 8);
const base = () => chrome.runtime.getURL('sample/');

export const isSample = (s: Pick<SessionRecord, 'sample'>): boolean => s.sample === true;

export async function sampleSessionIds(): Promise<string[]> {
  return (await dbGetAll<SessionRecord>('sessions')).filter(isSample).map((s) => s.id);
}

/** Loads the bundled sample sessions, re-dated so the newest one ended about two minutes ago. Any earlier sample copy is replaced. */
export async function loadSamples(removeOne: (id: string) => Promise<void>): Promise<string[]> {
  for (const id of await sampleSessionIds()) await removeOne(id);
  const res = await fetch(base() + 'index.json');
  if (!res.ok) throw new Error('The sample data is missing from this build.');
  const b = (await res.json()) as Bundle;
  const delta = Date.now() - 120_000 - b.anchor;
  const sid = new Map(b.sessions.map((s) => [s.id, `s_sample_${rid()}`]));
  const shotId = new Map(b.shots.map((s) => [s.id, `shot_sample_${rid()}`]));
  const T = (t: number | null | undefined) => (typeof t === 'number' ? t + delta : (t ?? null));

  const segs: SegmentMeta[] = [];
  for (const s of b.segments) {
    const id = `${Math.round(T(s.startWall)!)}-smp${rid()}`;
    const buf = await (await fetch(base() + s.file)).arrayBuffer();
    const chunks = decodeSegment(buf).map((c) => ({ ...c, timestampUs: c.timestampUs + delta * 1000 }));
    const blob = encodeSegment(chunks);
    await opfsWrite(segPath(id), blob);
    const { file: _f, ...meta } = s;
    void _f;
    segs.push({ ...meta, id, startWall: T(s.startWall)!, endWall: T(s.endWall)!, bytes: blob.size, refs: s.refs.map((r) => sid.get(r)).filter((r): r is string => !!r) });
  }
  await dbPutMany('segments', segs);

  const shots: ScreenshotItem[] = [];
  for (const sh of b.shots) {
    const id = shotId.get(sh.id)!;
    const file = `shots/${id}.png`;
    await opfsWrite(file, await (await fetch(base() + sh.file)).blob());
    const { file: _f, ...rest } = sh;
    void _f;
    shots.push({ ...rest, id, file, sessionId: sid.get(sh.sessionId)!, ts: T(sh.ts)!, annotations: [] });
  }
  await dbPutMany('shots', shots);

  const sessions: SessionRecord[] = b.sessions.map((s) => ({
    ...s, id: sid.get(s.id)!, sample: true, createdAt: T(s.createdAt)!, startedAt: T(s.startedAt)!, endedAt: T(s.endedAt), lastCommittedAt: T(s.lastCommittedAt),
    preContext: s.preContext ? { ...s.preContext, startWall: T(s.preContext.startWall)!, endWall: T(s.preContext.endWall)! } : null, videoEdits: undefined, reviewedAt: undefined,
  }));
  await dbPutMany('sessions', sessions);
  const evs = b.events.map((e) => ({ ...e, sessionId: sid.get(e.sessionId)!, ts: T(e.ts)!, evidenceId: e.evidenceId ? shotId.get(e.evidenceId) ?? e.evidenceId : undefined }));
  await dbPutMany('events', evs); // autoIncrement key: no id on purpose
  for (const r of b.reports) {
    const { sessionKey, ...rep } = r;
    const sessionId = sid.get(sessionKey)!;
    await dbPut('reports', { ...rep, id: 'r_' + sessionId, sessionId, updatedAt: Date.now() } satisfies ReportRecord);
  }
  return sessions.map((s) => s.id);
}
