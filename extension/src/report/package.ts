// Full-fidelity Evidence Package (ZIP) with a versioned manifest and SHA-256 hashes (EXP-01, EXP-12).
import { strToU8, zipSync } from 'fflate';
import type { ReportModel } from './model';
import type { ScreenshotItem, SessionRecord, TimelineEvent } from '../shared/types';
import { renderHtml } from './render-html';
import { renderMarkdown, renderTxt } from './render-text';
import type { MuxedVideo } from './video';

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const MANIFEST_SCHEMA_VERSION = 1;

export interface PackageInput {
  model: ReportModel;
  session: SessionRecord;
  events: TimelineEvent[];
  shots: ScreenshotItem[];
  video: MuxedVideo | null;
  videoBytes?: Uint8Array;
  extraFiles?: Record<string, Uint8Array>;
  keepPre: boolean;
  version: string;
}

export async function buildEvidencePackage(inp: PackageInput): Promise<Blob> {
  const { model, session, events, shots, video } = inp;
  const files: Record<string, Uint8Array> = {};
  files['report.html'] = strToU8(renderHtml(model, 'zip'));
  files['report.txt'] = strToU8(renderTxt(model));
  files['report.md'] = strToU8(renderMarkdown(model));
  if (inp.videoBytes && model.video) files[model.video.filename] = inp.videoBytes;
  model.screenshots.forEach((s) => s.data && (files[s.filename] = s.data));
  Object.assign(files, inp.extraFiles ?? {});
  // Raw timeline stays separate from the draft steps (ACT-04). Values are always null by policy.
  const visibleEvents = events.filter((e) => inp.keepPre || e.ts >= session.startedAt);
  files['events.json'] = strToU8(
    JSON.stringify(visibleEvents.map((e) => ({ ts_ms: e.ts - session.startedAt, ts: e.ts, type: e.type, target: e.origin ? { kind: 'web', origin: e.origin, path: e.path } : undefined, element: e.element, value: null, label: e.label, system: e.system, source: e.source, confidence: e.confidence })), null, 2),
  );
  files['session.json'] = strToU8(JSON.stringify({ ...session, screenshots: shots.map(({ id, ts, origin, path, browser, viewport, captureMode, markerOrdinal }) => ({ id, ts, origin, path, browser, viewport, captureMode, markerOrdinal })) }, null, 2));
  const artifacts: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const [path, data] of Object.entries(files)) artifacts.push({ path, bytes: data.byteLength, sha256: await sha256Hex(data) });
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    reprodesk_version: inp.version,
    build: 'phase0-spike',
    browser: session.browser,
    capture_mode: session.kind,
    target_profile_id: 'local-default',
    capture_policy_version: '0.2.4',
    session_id: session.id,
    status: session.status,
    start: new Date(session.startedAt).toISOString(),
    end: session.endedAt ? new Date(session.endedAt).toISOString() : null,
    last_committed: session.lastCommittedAt ? new Date(session.lastCommittedAt).toISOString() : null,
    pre_session_context: session.preContext ? { present: true, kept: inp.keepPre, seconds: Math.round((session.preContext.endWall - session.preContext.startWall) / 1000) } : { present: false },
    video: video ? { codec: video.codec, width: video.width, height: video.height, start_wall_ms: video.startWall, duration_ms: video.durationMs, gaps: video.gaps } : null,
    notes: 'sha256 values are integrity metadata only, not a claim of forensic chain-of-custody.',
    artifacts,
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  // Video is already compressed: store it; compress the rest.
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const [p, d] of Object.entries(files)) entries[p] = [d, { level: /\.(webm|png)$/.test(p) ? 0 : 6 }];
  return new Blob([zipSync(entries) as BlobPart], { type: 'application/zip' });
}
