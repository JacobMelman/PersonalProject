import { dbGet, dbIndexAll, dbPut, eventsOfSession } from '../storage/db';
import { opfsRead } from '../storage/opfs';
import type { ReportRecord, ScreenshotItem, SessionRecord, TimelineEvent } from '../shared/types';
import { defaultTitle, pngSize } from './model';
import { sanitize } from '../shared/annotations';
import { flatten } from '../ui/annotate-render';

export interface LoadedShot extends ScreenshotItem {
  /** What reports embed: the flattened annotated derivative (or the original when there are no annotations). */
  data: Uint8Array;
  /** The immutable original screenshot. */
  original: Uint8Array;
  width: number;
  height: number;
}
export interface LoadedEvidence {
  session: SessionRecord;
  events: TimelineEvent[];
  shots: LoadedShot[];
  report: ReportRecord;
}

export async function loadEvidence(sessionId: string): Promise<LoadedEvidence | null> {
  const session = await dbGet<SessionRecord>('sessions', sessionId);
  if (!session) return null;
  const events = await eventsOfSession<TimelineEvent>(sessionId);
  const rows = (await dbIndexAll<ScreenshotItem>('shots', 'sessionId', sessionId)).sort((a, b) => a.ts - b.ts);
  const shots: LoadedShot[] = [];
  for (const r of rows) {
    try {
      const original = new Uint8Array(await (await opfsRead(r.file)).arrayBuffer());
      const annotations = sanitize(r.annotations);
      const data = annotations.length ? await flatten(new Blob([original as BlobPart], { type: 'image/png' }), annotations) : original;
      shots.push({ ...r, annotations, original, data, ...pngSize(original) });
    } catch {
      /* missing file: skipped rather than faked */
    }
  }
  const id = 'r_' + sessionId;
  const report =
    (await dbGet<ReportRecord>('reports', id)) ??
    ({ id, sessionId, title: defaultTitle(session), actual: '', expected: '', notes: '', severity: '', updatedAt: Date.now() } satisfies ReportRecord);
  return { session, events, shots, report };
}

export const saveReport = (r: ReportRecord) => dbPut('reports', { ...r, updatedAt: Date.now() });
