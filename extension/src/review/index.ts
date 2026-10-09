import { loadEvidence, saveReport, type LoadedEvidence } from '../report/evidence';
import { buildReportModel, SESSION_TYPE, type ReportModel } from '../report/model';
import { muxSessionVideo, type MuxedVideo } from '../report/video';
import { renderEditedVideo } from '../report/video-redact';
import { activeMasks, afterCuts, editId, hasEdits, inCut, normalizeCuts, sanitizeEdits, type VideoEdits } from '../shared/video-edits';
import { renderHtml } from '../report/render-html';
import { renderMarkdown, renderTxt } from '../report/render-text';
import { renderDocx } from '../report/render-docx';
import { renderXlsx } from '../report/render-xlsx';
import { buildEvidencePackage } from '../report/package';
import { expandTemplate, formatClock, sanitizeFilename, stamp, uniqueName } from '../shared/filename';
import { dbGetAll, dbPut } from '../storage/db';
import type { ScreenshotItem } from '../shared/types';
import { sessionThumb } from '../report/thumb';
import { openEditor } from './editor';
import { flatten } from '../ui/annotate-render';
import { hasRedaction } from '../shared/annotations';
import type { SessionRecord, TimelineEvent, TimelineType } from '../shared/types';
import { icon, type IconName } from '../ui/icons';
import { logo } from '../ui/brand';
import { getPolicy } from '../shared/settings';
import { allowedFormats, type ExportFormat, type Policy } from '../shared/policy';
import { ago, bytes, duration, esc, host } from '../ui/format';

const app = document.getElementById('app')!;
const VERSION = chrome.runtime.getManifest().version;
const sessionId = new URLSearchParams(location.search).get('session');

const KIND_ICON: Record<string, IconName> = { instant: 'history', repro: 'video', screenshot: 'camera' };
const TL_ICON: Record<TimelineType, IconName> = { click: 'mouse-pointer-click', navigate: 'navigation', marker: 'flag', screenshot: 'camera', focus: 'text-cursor-input', submit: 'send', system: 'info' };
const FORMATS: Array<{ id: string; name: string; sub: string; icon: IconName; on?: boolean }> = [
  { id: 'zip', name: 'Evidence ZIP', sub: 'Video, shots, events, manifest', icon: 'archive', on: true },
  { id: 'html', name: 'HTML', sub: 'Self-contained report', icon: 'file-code-2', on: true },
  { id: 'docx', name: 'Word', sub: 'DOCX with screenshots', icon: 'file-type-2' },
  { id: 'xlsx', name: 'Excel', sub: 'Report, steps, timeline', icon: 'file-spreadsheet' },
  { id: 'txt', name: 'Text', sub: 'Plain TXT', icon: 'file-text' },
  { id: 'md', name: 'Markdown', sub: 'For Jira / ADO', icon: 'copy' },
];
const statusBadge = (s: SessionRecord) =>
  s.status === 'finished' ? '<span class="badge ok">Saved</span>' : s.status === 'active' ? '<span class="badge live">Live</span>' : s.status === 'target_ended' ? '<span class="badge bad">Target ended</span>' : '<span class="badge warn">Recovered</span>';

const topbar = (crumb: string) => `<div class="topbar"><div class="brand">${logo(30)}<b>ReproDesk</b><span class="pill accent">Phase 0</span></div>
  <div class="crumb" style="margin-left:14px"><a href="review.html">Sessions</a>${crumb ? `${icon('chevron-right')}<span>${crumb}</span>` : ''}</div></div>`;

async function list(): Promise<void> {
  const rows = (await dbGetAll<SessionRecord>('sessions')).sort((a, b) => b.createdAt - a.createdAt);
  const thumbs = await Promise.all(rows.map((r) => sessionThumb(r.id)));
  app.innerHTML = `<div class="page">${topbar('')}
    <div class="pagehead"><div><h1>Sessions</h1><p class="muted" style="margin-top:4px">${rows.length} saved on this device · nothing leaves your browser until you export</p></div></div>
    ${rows.length ? `<div class="cards">${rows.map((s, i) => `<a class="scard" href="?session=${encodeURIComponent(s.id)}"><div class="cover ${s.kind}">${thumbs[i] ? `<img src="${thumbs[i]}" alt="">` : icon(KIND_ICON[s.kind] ?? 'video')}</div>
      <div class="body"><b>${SESSION_TYPE[s.kind] ?? s.kind}</b><div class="small muted">${esc(host(s.targetOrigin))} · ${ago(s.createdAt)}</div><div class="chips">${statusBadge(s)}<span class="badge">${s.endedAt ? duration(s.endedAt - s.startedAt) : 'live'}</span><span class="badge">${esc(s.environment)}</span>${s.sample ? '<span class="badge accent">Sample</span>' : ''}</div></div></a>`).join('')}</div>`
      : `<div class="empty" style="padding:60px">${icon('film')}<b>No sessions yet</b><span>Arm ReproDesk on the app you test, then save a replay or start a Repro Session.</span></div>`}</div>`;
}

async function detail(id: string): Promise<void> {
  const loaded = await loadEvidence(id);
  if (!loaded) {
    app.innerHTML = `<div class="page">${topbar('Not found')}<div class="empty" style="padding:60px">${icon('triangle-alert')}<b>Session not found</b><span>It may have been deleted.</span></div></div>`;
    return;
  }
  const ev: LoadedEvidence = loaded;
  const policy: Policy = await getPolicy();
  const okFormats = allowedFormats(policy);
  const formats = FORMATS.filter((f) => okFormats.includes(f.id as ExportFormat));
  const confirmExport = (): boolean =>
    !policy.requireExportConfirmation ||
    confirm('Your organization asks you to confirm before exporting.\n\nVideo and screenshots can show sensitive values that were visible in the tested application. Have you checked the evidence and hidden what must not leave this device?');
  let keepPre = ev.session.preContext?.kept ?? true;
  let video: MuxedVideo | null = null;
  let videoUrl = '';
  let videoErr = '';
  let exportNote = '';
  let edits: VideoEdits = sanitizeEdits(ev.session.videoEdits, 24 * 3600 * 1000);
  let previewing = false;
  let previewUrl = '';
  let maskDraft: { x1: number; y1: number; x2: number; y2: number } | null = null;

  const buildVideo = async () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    video = null;
    videoUrl = '';
    try {
      const pre = ev.session.preContext;
      video = await muxSessionVideo(id, !keepPre && pre ? ev.session.startedAt : 0);
      if (video) videoUrl = URL.createObjectURL(video.blob);
    } catch (e) {
      videoErr = e instanceof Error ? e.message : String(e);
    }
  };
  const model = (over?: { events?: TimelineEvent[]; shots?: LoadedEvidence['shots']; video?: MuxedVideo | null }): ReportModel => {
    const v = over && 'video' in over ? over.video : video;
    return buildReportModel({
      session: ev.session, events: over?.events ?? ev.events, shots: over?.shots ?? ev.shots, report: ev.report, keepPre,
      videoInfo: v ? { filename: 'replay.webm', startWall: v.startWall, durationMs: v.durationMs, codec: v.codec, width: v.width, height: v.height } : null,
    });
  };

  await buildVideo();
  const shotUrls = ev.shots.map((s) => URL.createObjectURL(new Blob([s.data as BlobPart], { type: 'image/png' })));
  const visibleEvents = () => ev.events.filter((e) => keepPre || e.ts >= ev.session.startedAt).sort((a, b) => a.ts - b.ts);

  const draw = () => {
    const s = ev.session;
    const m = model();
    const pre = s.preContext;
    const events = visibleEvents();
    const markers = events.filter((e) => e.type === 'marker');
    const classOpts = ['', 'UI/Application crashed', 'Fatal error and closed', 'Tab crashed', 'Browser closed', 'Application became unresponsive', 'Other'];
    app.innerHTML = `<div class="page">${topbar(esc(SESSION_TYPE[s.kind] ?? s.kind))}
    <div class="title"><div><h1>${esc(ev.report.title)}</h1>
      <div class="meta">${statusBadge(s)}<span class="chip">${icon(KIND_ICON[s.kind] ?? 'video')}${esc(m.sessionType)}</span><span class="chip">${icon('globe')}${esc(host(s.targetOrigin))}</span><span class="chip">${icon('layers')}${esc(s.environment)}</span><span class="chip">${icon('monitor')}${esc(s.browser)}</span><span class="chip">${icon('clock')}${new Date(s.startedAt).toLocaleString()}</span></div></div>
      <button class="btn danger sm" id="del">${icon('trash-2')}Delete session</button></div>
    ${m.endNote ? `<div class="callout bad">${icon('triangle-alert')}<div>${esc(m.endNote)}</div></div>` : ''}
    ${ev.session.sample ? `<div class="callout sample">${icon('sparkles')}<div><b>Sample session.</b> A pre-recorded, scripted run of a demo shop, not real evidence. Try the blur / redact tools and the exports freely; remove it any time under Settings → Sample data in the side panel.</div></div>` : ''}
    <div class="callout">${icon('eye-off')}<div><b>Check before sharing.</b> Values visible in the tested application may appear in video and screenshots even though typed values are never collected. Inspect before sharing. Evidence stays on this device until you export it.</div></div>
    ${s.status === 'target_ended' || s.status === 'recovered' ? `<div class="panelcard card" style="margin-bottom:20px"><div class="field" style="margin:0"><label>Outcome classification</label><select class="input" id="cls">${classOpts.map((c) => `<option ${c === (s.classification ?? '') ? 'selected' : ''}>${c}</option>`).join('')}</select></div><div class="field" style="margin:12px 0 0"><label>Comment</label><input class="input" type="text" id="clsnote" value="${esc(s.classificationNote ?? '')}"></div></div>` : ''}
    <div class="stats">
      <div class="stat"><div class="v num">${duration(s.endedAt ? s.endedAt - s.startedAt : (video?.durationMs ?? null))}</div><div class="l">${icon('clock')}Duration</div></div>
      <div class="stat"><div class="v num">${m.steps.length}</div><div class="l">${icon('list-checks')}Steps</div></div>
      <div class="stat"><div class="v num">${markers.length}</div><div class="l">${icon('flag')}Markers</div></div>
      <div class="stat"><div class="v num">${ev.shots.length}</div><div class="l">${icon('camera')}Screenshots</div></div>
      <div class="stat"><div class="v num">${video ? bytes(video.blob.size) : '—'}</div><div class="l">${icon('hard-drive')}Video${video ? ` · ${video.width}×${video.height}` : ''}</div></div>
    </div>
    <div class="grid2"><div class="col">
      <section class="card panelcard"><h2>${icon('film')}Replay</h2>
        ${video ? `<div class="player"><div class="stage" id="stage"><video id="vid" controls playsinline src="${videoUrl}"></video><div class="vover" id="vover"></div></div><div class="player__bar"><span>${icon('video')} ${video.codec.startsWith('vp09') ? 'VP9' : 'VP8'} · ${video.segments} GOP segments${video.gaps.length ? ` · ${video.gaps.length} capture gap${video.gaps.length > 1 ? 's' : ''} (pauses)` : ''}</span><span style="margin-left:auto">Click a timeline row to jump</span></div></div>
        <div class="ptools" id="ptools"><div class="ptools__head">${icon('shield-alert')}<b>Privacy tools</b><span class="faint small">hide sensitive pixels before export</span></div>
          <div class="ptools__btns"><button class="btn sm" id="pt-mask">${icon('grid-3x3')}Mask a region</button><button class="btn sm" id="pt-cut">${icon('scissors')}Cut out a range</button><button class="btn sm" id="pt-preview">${icon('eye-off')}Preview redacted</button></div>
          <div id="pt-form"></div><ul class="pt-list" id="pt-list"></ul></div>`
          : `<div class="novideo">${icon('film')}<b>No video available</b><span>${esc(s.videoFailure ?? videoErr ?? 'This session has no video.')}</span></div>`}
        ${pre ? `<div class="setrow" style="border:0;padding-bottom:0"><div><div class="t">Pre-session context</div><div class="s">${Math.round((pre.endWall - pre.startWall) / 1000)} s recorded before Start, shown separately and kept out of the steps</div></div><label class="switch"><input type="checkbox" id="prekeep" ${keepPre ? 'checked' : ''}><span></span></label></div>` : ''}
      </section>
      <section class="card panelcard"><h2>${icon('route')}Timeline<span class="sp small faint">raw, nothing is hidden</span></h2>
        <div class="timeline" id="tl" tabindex="0" role="region" aria-label="Timeline">${events.map((e, i) => {
          const rel = e.ts < s.startedAt ? `-${formatClock(s.startedAt - e.ts)}` : formatClock(e.ts - s.startedAt);
          const text = esc(m.timeline[i]?.text ?? e.type);
          return `<div class="tl ${e.type} ${e.ts < s.startedAt ? 'pre' : ''}" data-i="${i}"><span class="t">${rel}</span><span class="ic">${icon(TL_ICON[e.type] ?? 'info')}</span><span class="tx">${text}</span></div>`;
        }).join('') || '<div class="muted small" style="padding:10px">No events.</div>'}</div></section>
      ${ev.shots.length ? `<section class="card panelcard"><h2>${icon('image')}Screenshots<span class="sp small faint">${ev.shots.length} · pencil = annotate / blur</span></h2><div class="gallery">${ev.shots.map((sh, i) => `<div class="shot"><a href="${shotUrls[i]}" data-shot="${i}"><img src="${shotUrls[i]}" alt="screenshot ${i + 1}"></a>${sh.annotations.length ? `<span class="flag badge ${hasRedaction(sh.annotations) ? 'warn' : 'live'}">${hasRedaction(sh.annotations) ? 'Redacted' : 'Annotated'}</span>` : ''}<div class="edit"><button class="iconbtn" data-edit="${i}" title="Annotate, blur or redact" aria-label="Annotate screenshot ${i + 1}">${icon('pencil')}</button></div><div class="cap"><span>${sh.markerOrdinal ? `Marker ${sh.markerOrdinal}` : `Shot ${i + 1}`}</span><span class="num">${formatClock(Math.max(0, sh.ts - s.startedAt))}</span></div></div>`).join('')}</div></section>` : ''}
    </div><div class="col">
      <section class="card panelcard"><h2>${icon('file-text')}Report</h2>
        <div class="field"><label for="f-title">Title</label><input class="input" type="text" id="f-title" value="${esc(ev.report.title)}"></div>
        <div class="field"><label for="f-sev">Severity</label><input class="input" type="text" id="f-sev" value="${esc(ev.report.severity)}" placeholder="e.g. Major"></div>
        <div class="field"><label for="f-actual">Actual result</label><textarea class="input" id="f-actual" placeholder="What happened?">${esc(ev.report.actual)}</textarea></div>
        <div class="field"><label for="f-exp">Expected result</label><textarea class="input" id="f-exp" placeholder="What should have happened? (always written by you)">${esc(ev.report.expected)}</textarea></div>
        <div class="field" style="margin:0"><label for="f-notes">Notes</label><textarea class="input" id="f-notes" placeholder="Optional">${esc(ev.report.notes)}</textarea></div></section>
      <section class="card panelcard"><h2>${icon('list-checks')}Steps to reproduce<span class="sp small faint">draft · observed actions only</span></h2>
        ${m.steps.length ? `<ol class="steps">${m.steps.slice(0, 40).map((st) => `<li><span>${esc(st.text)}</span><span class="rel">${st.rel}</span></li>`).join('')}</ol>` : '<p class="muted small">No actions were recorded.</p>'}</section>
      ${markers.length ? `<section class="card panelcard"><h2>${icon('flag')}Markers</h2><div class="markers">${markers.map((e) => `<div class="markrow">${icon('flag')}<input class="input" type="text" aria-label="Marker label" data-marker="${e.id}" value="${esc(e.label ?? '')}"><span class="small faint num">${formatClock(Math.max(0, e.ts - s.startedAt))}</span></div>`).join('')}</div></section>` : ''}
      <section class="card panelcard"><h2>${icon('download')}Export</h2>
        ${policy.managed && (policy.allowedExportFormats || !policy.allowUnredactedOriginals || policy.requireExportConfirmation) ? `<p class="small faint" id="export-managed">${icon('lock')}Export options are set by your organization.</p>` : ''}
        ${formats.length ? '' : `<p class="small" id="export-none" style="color:var(--red-ink)">${icon('triangle-alert')}Exporting is turned off by your organization.</p>`}
        <div class="formats">${formats.map((f) => `<label class="fmt"><input type="checkbox" data-fmt="${f.id}" ${f.on ? 'checked' : ''} aria-label="${f.name}">${icon(f.icon)}<b>${f.name}</b><span>${f.sub}</span><i class="tick">${icon('check')}</i></label>`).join('')}</div>
        ${policy.allowUnredactedOriginals && ev.shots.some((x) => x.annotations.length) ? `<div class="setrow" style="padding:12px 0 0;border:0"><div><div class="t">Include original screenshots</div><div class="s">Unredacted originals go into the ZIP only if you switch this on</div></div><label class="switch"><input type="checkbox" id="inc-orig"><span></span></label></div>` : ''}
        <div class="field" style="margin:14px 0 0"><label for="fname">File name</label><input class="input" type="text" id="fname" value="Bug-{date}_{time}"><span class="hint" id="fprev"></span></div>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">${formats.length ? `<button class="btn primary" id="export" style="flex:1">${icon('download')}Export selected</button>` : ''}${okFormats.includes('md') ? `<button class="btn" id="cpmd">${icon('copy')}Markdown</button>` : ''}${okFormats.includes('txt') ? `<button class="btn" id="cptxt">${icon('copy')}Text</button>` : ''}</div>
        <div class="exstatus" id="exstatus">${exportNote}</div></section>
    </div></div></div>
    <div class="lightbox" id="lightbox" hidden><img alt=""><button class="iconbtn" id="lbclose" aria-label="Close">${icon('x')}</button></div>`;
    wire(m);
  };

  const readFields = () => {
    ev.report = {
      ...ev.report,
      title: (document.getElementById('f-title') as HTMLInputElement).value,
      severity: (document.getElementById('f-sev') as HTMLInputElement).value,
      actual: (document.getElementById('f-actual') as HTMLTextAreaElement).value,
      expected: (document.getElementById('f-exp') as HTMLTextAreaElement).value,
      notes: (document.getElementById('f-notes') as HTMLTextAreaElement).value,
    };
  };

  // ---------------------------------------------------------------- privacy tools for the replay
  const parseT = (v: string): number | null => {
    const t = v.trim();
    if (!t) return null;
    const m = /^(\d+):(\d{1,2})(?:\.(\d+))?$/.exec(t);
    if (m) return (Number(m[1]) * 60 + Number(m[2])) * 1000 + (m[3] ? Number(`0.${m[3]}`) * 1000 : 0);
    return Number.isFinite(Number(t)) ? Number(t) * 1000 : null;
  };
  const saveEdits = async () => {
    ev.session = { ...ev.session, videoEdits: edits };
    await dbPut('sessions', ev.session);
  };
  function contentRect(vid: HTMLVideoElement) {
    const r = vid.getBoundingClientRect();
    const ar = (vid.videoWidth || 16) / (vid.videoHeight || 9);
    let w = r.width, h = r.height;
    if (r.width / r.height > ar) w = r.height * ar; else h = r.width / ar;
    return { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h };
  }
  function wirePrivacy(vid: HTMLVideoElement | null): void {
    const box = document.getElementById('ptools');
    if (!box || !vid || !video) return;
    const stage = document.getElementById('stage')!;
    const over = document.getElementById('vover')!;
    const form = document.getElementById('pt-form')!;
    const list = document.getElementById('pt-list')!;
    const dur = video.durationMs;
    const nowMs = () => Math.round(vid.currentTime * 1000);
    const pct = (v: number) => `${Math.round(v * 100)}%`;

    const paintOverlay = () => {
      over.innerHTML = '';
      if (previewing) return;
      const c = contentRect(vid);
      const t = nowMs();
      for (const m of activeMasks(edits.masks, t)) {
        const d = document.createElement('div');
        d.className = `vmask ${m.type}`;
        d.style.cssText = `left:${c.x + Math.min(m.x1, m.x2) * c.w}px;top:${c.y + Math.min(m.y1, m.y2) * c.h}px;width:${Math.abs(m.x2 - m.x1) * c.w}px;height:${Math.abs(m.y2 - m.y1) * c.h}px`;
        over.appendChild(d);
      }
      if (maskDraft) {
        const d = document.createElement('div');
        d.className = 'vmask draft';
        d.style.cssText = `left:${c.x + Math.min(maskDraft.x1, maskDraft.x2) * c.w}px;top:${c.y + Math.min(maskDraft.y1, maskDraft.y2) * c.h}px;width:${Math.abs(maskDraft.x2 - maskDraft.x1) * c.w}px;height:${Math.abs(maskDraft.y2 - maskDraft.y1) * c.h}px`;
        over.appendChild(d);
      }
    };
    const paintList = () => {
      const items = [
        ...edits.masks.map((m) => `<li><span class="pt-ic">${icon(m.type === 'blur' ? 'grid-3x3' : 'rectangle-horizontal')}</span><span><b>${m.type === 'blur' ? 'Blur' : 'Redact'}</b> ${formatClock(m.fromMs)}–${formatClock(m.toMs)} <span class="faint small">· ${pct(Math.abs(m.x2 - m.x1))}×${pct(Math.abs(m.y2 - m.y1))}</span></span><button class="iconbtn" data-rm-mask="${m.id}" aria-label="Remove mask">${icon('trash-2')}</button></li>`),
        ...edits.cuts.map((c) => `<li><span class="pt-ic">${icon('scissors')}</span><span><b>Cut out</b> ${formatClock(c.fromMs)}–${formatClock(c.toMs)} <span class="faint small">· frames, events and screenshots in this range are dropped from exports</span></span><button class="iconbtn" data-rm-cut="${c.id}" aria-label="Remove cut">${icon('trash-2')}</button></li>`),
      ];
      list.innerHTML = items.join('') || `<li class="faint small" style="padding:6px 2px">No privacy edits. The exported video is the untouched recording.</li>`;
      (document.getElementById('pt-preview') as HTMLButtonElement).disabled = !hasEdits(edits);
    };
    const refresh = () => { paintList(); paintOverlay(); };
    // From rounds down and To rounds up (the fields hold whole seconds): an edge off by a fraction always hides more, never less.
    const clockUp = (ms: number) => formatClock(Math.ceil(ms / 1000) * 1000);
    const timeInputs = (from: number, to: number) => `<label>From <input class="input sm" id="pt-from" value="${formatClock(from)}" size="6"></label><button class="btn ghost sm" id="pt-from-now">now</button><label>To <input class="input sm" id="pt-to" value="${clockUp(to)}" size="6"></label><button class="btn ghost sm" id="pt-to-now">now</button>`;
    const bindNow = () => {
      document.getElementById('pt-from-now')?.addEventListener('click', () => ((document.getElementById('pt-from') as HTMLInputElement).value = formatClock(nowMs())));
      document.getElementById('pt-to-now')?.addEventListener('click', () => ((document.getElementById('pt-to') as HTMLInputElement).value = clockUp(nowMs())));
    };
    const closeForm = () => { form.innerHTML = ''; maskDraft = null; stage.querySelector('.maskdraw')?.remove(); refresh(); };
    const readRange = () => {
      const f = parseT((document.getElementById('pt-from') as HTMLInputElement).value), t = parseT((document.getElementById('pt-to') as HTMLInputElement).value);
      if (f == null || t == null || t <= f) return null;
      return { fromMs: Math.max(0, f), toMs: Math.min(dur, t) };
    };

    document.getElementById('pt-mask')!.addEventListener('click', () => {
      closeForm();
      vid.pause();
      form.innerHTML = `<div class="ptform"><span class="faint small">${icon('crosshair')} Pause on a frame where the data is visible, then drag a rectangle over it.</span><button class="btn ghost sm" id="pt-cancel">Cancel</button></div>`;
      document.getElementById('pt-cancel')!.addEventListener('click', closeForm);
      const layer = document.createElement('div');
      layer.className = 'maskdraw';
      stage.appendChild(layer);
      stage.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      let start: { x: number; y: number } | null = null;
      const at = (e: PointerEvent) => { const c = contentRect(vid), r = vid.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left - c.x) / c.w)), y: Math.min(1, Math.max(0, (e.clientY - r.top - c.y) / c.h)) }; };
      layer.addEventListener('pointerdown', (e) => { layer.setPointerCapture(e.pointerId); start = at(e); maskDraft = { x1: start.x, y1: start.y, x2: start.x, y2: start.y }; paintOverlay(); });
      layer.addEventListener('pointermove', (e) => { if (!start) return; const p = at(e); maskDraft = { x1: start.x, y1: start.y, x2: p.x, y2: p.y }; paintOverlay(); });
      layer.addEventListener('pointerup', () => {
        if (!start || !maskDraft) return;
        const d = maskDraft; start = null;
        if (Math.abs(d.x2 - d.x1) < 0.01 || Math.abs(d.y2 - d.y1) < 0.01) { maskDraft = null; paintOverlay(); return; }
        layer.remove();
        form.innerHTML = `<div class="ptform"><div class="seg" id="pt-type"><button class="on" data-t="blur">Blur</button><button data-t="redact">Black box</button></div>${timeInputs(nowMs(), dur)}<button class="btn primary sm" id="pt-add">Add mask</button><button class="btn ghost sm" id="pt-cancel2">Cancel</button></div><p class="faint small" style="margin:6px 0 0">Hidden from this frame to the end of the recording unless you narrow it. Times follow the player clock (the context before Start included): seek, then press now. The original recording stays untouched on this device.</p>`;
        bindNow();
        let type: 'blur' | 'redact' = 'blur';
        form.querySelectorAll<HTMLElement>('#pt-type button').forEach((b) => b.addEventListener('click', () => { type = b.dataset.t as 'blur' | 'redact'; form.querySelectorAll('#pt-type button').forEach((x) => x.classList.toggle('on', x === b)); }));
        document.getElementById('pt-cancel2')!.addEventListener('click', closeForm);
        document.getElementById('pt-add')!.addEventListener('click', async () => {
          const r = readRange();
          if (!r) return void (form.querySelector('.faint')!.textContent = 'Enter a valid range (mm:ss), the end after the start.');
          edits = { ...edits, masks: [...edits.masks, { id: editId('mk'), type, x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, ...r }] };
          await saveEdits();
          closeForm();
        });
      });
    });
    document.getElementById('pt-cut')!.addEventListener('click', () => {
      closeForm();
      form.innerHTML = `<div class="ptform">${timeInputs(nowMs(), Math.min(dur, nowMs() + 5000))}<button class="btn primary sm" id="pt-add">Cut out</button><button class="btn ghost sm" id="pt-cancel">Cancel</button></div><p class="faint small" style="margin:6px 0 0">Removes the range from the exported video, the timeline, steps and screenshots.</p>`;
      bindNow();
      document.getElementById('pt-cancel')!.addEventListener('click', closeForm);
      document.getElementById('pt-add')!.addEventListener('click', async () => {
        const r = readRange();
        if (!r) return void (form.querySelector('.faint')!.textContent = 'Enter a valid range (mm:ss), the end after the start.');
        edits = { ...edits, cuts: [...edits.cuts, { id: editId('cu'), ...r }] };
        await saveEdits();
        closeForm();
      });
    });
    list.addEventListener('click', async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-rm-mask],[data-rm-cut]');
      if (!b) return;
      edits = { masks: edits.masks.filter((m) => m.id !== b.dataset.rmMask), cuts: edits.cuts.filter((c) => c.id !== b.dataset.rmCut) };
      await saveEdits();
      refresh();
    });
    document.getElementById('pt-preview')!.addEventListener('click', async () => {
      if (previewing) {
        previewing = false;
        vid.src = videoUrl;
        document.getElementById('pt-preview')!.innerHTML = `${icon('eye-off')}Preview redacted`;
        form.innerHTML = '';
        return refresh();
      }
      form.innerHTML = `<div class="ptform"><span class="faint small" id="pt-prog">Rendering the redacted copy… 0%</span></div>`;
      try {
        const out = await renderEditedVideo(id, edits, { fromWall: !keepPre && ev.session.preContext ? ev.session.startedAt : 0, bitrateKbps: ev.session.settingsSnapshot.bitrateKbps, fps: ev.session.settingsSnapshot.fps, onProgress: (f) => { const el = document.getElementById('pt-prog'); if (el) el.textContent = `Rendering the redacted copy… ${Math.round(f * 100)}%`; } });
        if (!out) throw new Error('nothing to render');
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(out.blob);
        previewing = true;
        vid.src = previewUrl;
        form.innerHTML = `<div class="ptform"><span class="badge warn">Preview</span><span class="small muted">This is the redacted copy that will be exported. The original is unchanged.</span></div>`;
        document.getElementById('pt-preview')!.innerHTML = `${icon('rewind')}Back to original`;
        paintOverlay();
      } catch (err) {
        form.innerHTML = `<div class="ptform"><span class="small" style="color:var(--red)">Could not render: ${esc(err instanceof Error ? err.message : String(err))}</span></div>`;
      }
    });
    vid.addEventListener('timeupdate', paintOverlay);
    vid.addEventListener('seeked', paintOverlay);
    vid.addEventListener('loadedmetadata', paintOverlay);
    addEventListener('resize', paintOverlay);
    refresh();
  }

  function wire(m: ReportModel): void {
    const vid = document.getElementById('vid') as HTMLVideoElement | null;
    const tl = document.getElementById('tl');
    const events = visibleEvents();
    tl?.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null;
      if (!row || !vid || !video) return;
      const ms = events[Number(row.dataset.i)].ts - video.startWall;
      vid.currentTime = Math.max(0, (previewing ? afterCuts(ms, normalizeCuts(edits.cuts)) : ms) / 1000);
    });
    // live highlight: the timeline follows the video
    let lastIdx = -1;
    vid?.addEventListener('timeupdate', () => {
      if (!video) return;
      const wall = video.startWall + vid.currentTime * 1000;
      let idx = -1;
      for (let i = 0; i < events.length; i++) if (events[i].ts <= wall) idx = i;
      if (idx === lastIdx) return;
      lastIdx = idx;
      tl?.querySelectorAll('.tl.now').forEach((n) => n.classList.remove('now'));
      const row = tl?.querySelector<HTMLElement>(`[data-i="${idx}"]`);
      if (row && tl) {
        row.classList.add('now');
        tl.scrollTop = row.offsetTop - tl.clientHeight / 2 + row.clientHeight / 2;
      }
    });
    wirePrivacy(vid);
    document.getElementById('prekeep')?.addEventListener('change', async (e) => {
      readFields();
      keepPre = (e.target as HTMLInputElement).checked;
      if (ev.session.preContext) {
        ev.session = { ...ev.session, preContext: { ...ev.session.preContext, kept: keepPre } };
        await dbPut('sessions', ev.session);
      }
      await buildVideo();
      draw();
    });
    ['cls', 'clsnote'].forEach((cid) => document.getElementById(cid)?.addEventListener('change', async () => {
      ev.session = { ...ev.session, classification: (document.getElementById('cls') as HTMLSelectElement).value, classificationNote: (document.getElementById('clsnote') as HTMLInputElement).value };
      await dbPut('sessions', ev.session);
      draw();
    }));
    document.querySelectorAll<HTMLInputElement>('[data-marker]').forEach((inp) => inp.addEventListener('change', async () => {
      const target = ev.events.find((x) => String(x.id) === inp.dataset.marker) as TimelineEvent | undefined;
      if (!target) return;
      target.label = inp.value;
      await dbPut('events', target);
    }));
    ['f-title', 'f-sev', 'f-actual', 'f-exp', 'f-notes'].forEach((fid) => document.getElementById(fid)?.addEventListener('change', async () => {
      readFields();
      await saveReport(ev.report);
      if (fid === 'f-title') document.querySelector('.title h1')!.textContent = ev.report.title;
    }));
    // annotation editor
    document.querySelectorAll<HTMLElement>('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.edit);
      const sh = ev.shots[i];
      void openEditor({
        original: new Blob([sh.original as BlobPart], { type: 'image/png' }), annotations: sh.annotations, title: `Screenshot ${i + 1}`,
        onSave: async (list) => {
          readFields();
          const { data: _d, original: _o, width: _w, height: _h, ...item } = sh;
          void _d; void _o; void _w; void _h;
          await dbPut('shots', { ...item, annotations: list } satisfies ScreenshotItem);
          const data = list.length ? await flatten(new Blob([sh.original as BlobPart], { type: 'image/png' }), list) : sh.original;
          URL.revokeObjectURL(shotUrls[i]);
          shotUrls[i] = URL.createObjectURL(new Blob([data as BlobPart], { type: 'image/png' }));
          ev.shots[i] = { ...sh, annotations: list, data };
          draw();
        },
      });
    }));
    // lightbox
    const lb = document.getElementById('lightbox')!;
    document.querySelectorAll<HTMLAnchorElement>('[data-shot]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      (lb.querySelector('img') as HTMLImageElement).src = a.href;
      lb.hidden = false;
    }));
    lb.addEventListener('click', () => (lb.hidden = true));
    addEventListener('keydown', (e) => e.key === 'Escape' && (lb.hidden = true));

    const fname = document.getElementById('fname') as HTMLInputElement;
    const baseName = () => {
      const { date, time } = stamp(ev.session.startedAt);
      return sanitizeFilename(expandTemplate(fname.value, { date, time, title: ev.report.title, app: ev.session.targetOrigin?.replace(/^https?:\/\//, '') ?? '', env: ev.session.environment, type: m.sessionType }));
    };
    const preview = () => (document.getElementById('fprev')!.textContent = `Files: ${baseName()}.<ext>`);
    fname.addEventListener('input', preview);
    preview();

    const rebuild = async (over?: Parameters<typeof model>[0]) => {
      readFields();
      await saveReport(ev.report);
      return model(over);
    };
    const copy = async (kind: 'md' | 'txt') => {
      if (!confirmExport()) return;
      const mm = await rebuild();
      await navigator.clipboard.writeText(kind === 'md' ? renderMarkdown(mm) : renderTxt(mm));
      setStatus([`<div class="r okr">${icon('check')}Copied as ${kind === 'md' ? 'Markdown' : 'plain text'}</div>`]);
    };
    const setStatus = (rows: string[]) => {
      exportNote = rows.join('');
      document.getElementById('exstatus')!.innerHTML = exportNote;
    };
    document.getElementById('cpmd')?.addEventListener('click', () => void copy('md'));
    document.getElementById('cptxt')?.addEventListener('click', () => void copy('txt'));

    document.getElementById('export')?.addEventListener('click', async () => {
      if (!confirmExport()) return;
      // Privacy edits: frames/events/screenshots inside cut ranges never reach any export; masks are burned into the re-encoded video.
      const cutsN = normalizeCuts(edits.cuts);
      const edited = hasEdits(edits) && !!video;
      const keptEvents = edited && video ? ev.events.filter((e) => !inCut(e.ts - video!.startWall, cutsN)) : ev.events;
      const keptShots = edited && video ? ev.shots.filter((s2) => !inCut(s2.ts - video!.startWall, cutsN)) : ev.shots;
      let exportVideo: MuxedVideo | null = video;
      let exportVideoBytes: Uint8Array | undefined;
      if (edited && video && (document.querySelector('[data-fmt="zip"]') as HTMLInputElement | null)?.checked) {
        setStatus([`<div class="r">${icon('refresh-cw')}<span id="ex-prog">Rendering the redacted video… 0%</span></div>`]);
        try {
          const out = await renderEditedVideo(id, edits, { fromWall: !keepPre && ev.session.preContext ? ev.session.startedAt : 0, bitrateKbps: ev.session.settingsSnapshot.bitrateKbps, fps: ev.session.settingsSnapshot.fps, onProgress: (f) => { const el = document.getElementById('ex-prog'); if (el) el.textContent = `Rendering the redacted video… ${Math.round(f * 100)}%`; } });
          if (out) {
            exportVideo = { ...video, blob: out.blob, durationMs: out.durationMs };
            exportVideoBytes = new Uint8Array(await out.blob.arrayBuffer());
          }
        } catch (err) {
          return setStatus([`<div class="r bad">${icon('triangle-alert')}<span>Redacted video could not be rendered, nothing was exported: ${esc(err instanceof Error ? err.message : String(err))}</span></div>`]);
        }
      }
      const mm = await rebuild({ events: keptEvents, shots: keptShots, video: exportVideo });
      const fmts = [...document.querySelectorAll<HTMLInputElement>('[data-fmt]')].filter((c) => c.checked).map((c) => c.dataset.fmt!).filter((f) => okFormats.includes(f as ExportFormat));
      if (!fmts.length) return setStatus([`<div class="r bad">${icon('triangle-alert')}Select at least one format.</div>`]);
      const used = new Set<string>();
      const results: string[] = [];
      for (const f of fmts) {
        // Independent per-format generation: one failing format never alters or blocks the others.
        try {
          let blob: Blob;
          if (f === 'html') blob = new Blob([renderHtml(mm, 'inline')], { type: 'text/html' });
          else if (f === 'txt') blob = new Blob([renderTxt(mm)], { type: 'text/plain' });
          else if (f === 'md') blob = new Blob([renderMarkdown(mm)], { type: 'text/markdown' });
          else if (f === 'docx') blob = await renderDocx(mm);
          else if (f === 'xlsx') blob = renderXlsx(mm);
          else {
            const extraFiles: Record<string, Uint8Array> = {};
            if (policy.allowUnredactedOriginals && (document.getElementById('inc-orig') as HTMLInputElement | null)?.checked) {
              for (const sh of ev.shots) {
                const ref = mm.screenshots.find((x) => x.id === sh.id);
                if (ref && sh.annotations.length) extraFiles[ref.filename.replace('screenshots/', 'screenshots/originals/')] = sh.original;
              }
            }
            blob = await buildEvidencePackage({
              model: mm, session: ev.session, events: keptEvents, shots: keptShots, video: exportVideo, keepPre, version: VERSION, extraFiles,
              videoBytes: exportVideo ? exportVideoBytes ?? new Uint8Array(await exportVideo.blob.arrayBuffer()) : undefined,
              videoEdits: edited ? { masks: edits.masks.length, cuts: edits.cuts.length } : undefined,
            });
          }
          const name = uniqueName(`${baseName()}.${f}`, used);
          used.add(name.toLowerCase());
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
          results.push(`<div class="r okr">${icon('check')}<span>${f.toUpperCase()}: ok (${esc(name)}, ${bytes(blob.size)})</span></div>`);
        } catch (err) {
          results.push(`<div class="r bad">${icon('triangle-alert')}<span>${f.toUpperCase()}: FAILED - ${esc(err instanceof Error ? err.message : String(err))}</span></div>`);
        }
      }
      setStatus(results);
    });
    document.getElementById('del')!.addEventListener('click', async () => {
      if (!confirm('Delete this session and all of its evidence from this browser?')) return;
      await chrome.runtime.sendMessage({ kind: 'delete-session', id });
      location.search = '';
    });
  }

  draw();
}

if (sessionId) void detail(sessionId);
else void list();
