import { loadEvidence, saveReport, type LoadedEvidence } from '../report/evidence';
import { buildReportModel, SESSION_TYPE, type ReportModel } from '../report/model';
import { muxSessionVideo, type MuxedVideo } from '../report/video';
import { renderHtml } from '../report/render-html';
import { renderMarkdown, renderTxt } from '../report/render-text';
import { renderDocx } from '../report/render-docx';
import { renderXlsx } from '../report/render-xlsx';
import { buildEvidencePackage } from '../report/package';
import { expandTemplate, formatClock, sanitizeFilename, stamp, uniqueName } from '../shared/filename';
import { dbGetAll, dbPut } from '../storage/db';
import { sessionThumb } from '../report/thumb';
import type { SessionRecord, TimelineEvent, TimelineType } from '../shared/types';
import { icon, type IconName } from '../ui/icons';
import { logo } from '../ui/brand';
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
      <div class="body"><b>${SESSION_TYPE[s.kind] ?? s.kind}</b><div class="small muted">${esc(host(s.targetOrigin))} · ${ago(s.createdAt)}</div><div class="chips">${statusBadge(s)}<span class="badge">${s.endedAt ? duration(s.endedAt - s.startedAt) : 'live'}</span><span class="badge">${esc(s.environment)}</span></div></div></a>`).join('')}</div>`
      : `<div class="empty" style="padding:60px">${icon('film')}<b>No sessions yet</b><span>Arm ReproDesk on the app you test, then save a replay or start a Repro Session.</span></div>`}</div>`;
}

async function detail(id: string): Promise<void> {
  const loaded = await loadEvidence(id);
  if (!loaded) {
    app.innerHTML = `<div class="page">${topbar('Not found')}<div class="empty" style="padding:60px">${icon('triangle-alert')}<b>Session not found</b><span>It may have been deleted.</span></div></div>`;
    return;
  }
  const ev: LoadedEvidence = loaded;
  let keepPre = ev.session.preContext?.kept ?? true;
  let video: MuxedVideo | null = null;
  let videoUrl = '';
  let videoErr = '';
  let exportNote = '';

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
  const model = (): ReportModel =>
    buildReportModel({
      session: ev.session, events: ev.events, shots: ev.shots, report: ev.report, keepPre,
      videoInfo: video ? { filename: 'replay.webm', startWall: video.startWall, durationMs: video.durationMs, codec: video.codec, width: video.width, height: video.height } : null,
    });

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
        ${video ? `<div class="player"><video id="vid" controls playsinline src="${videoUrl}"></video><div class="player__bar"><span>${icon('video')} ${video.codec.startsWith('vp09') ? 'VP9' : 'VP8'} · ${video.segments} GOP segments${video.gaps.length ? ` · ${video.gaps.length} capture gap${video.gaps.length > 1 ? 's' : ''} (pauses)` : ''}</span><span style="margin-left:auto">Click a timeline row to jump</span></div></div>`
          : `<div class="novideo">${icon('film')}<b>No video available</b><span>${esc(s.videoFailure ?? videoErr ?? 'This session has no video.')}</span></div>`}
        ${pre ? `<div class="setrow" style="border:0;padding-bottom:0"><div><div class="t">Pre-session context</div><div class="s">${Math.round((pre.endWall - pre.startWall) / 1000)} s recorded before Start, shown separately and kept out of the steps</div></div><label class="switch"><input type="checkbox" id="prekeep" ${keepPre ? 'checked' : ''}><span></span></label></div>` : ''}
      </section>
      <section class="card panelcard"><h2>${icon('route')}Timeline<span class="sp small faint">raw, nothing is hidden</span></h2>
        <div class="timeline" id="tl">${events.map((e, i) => {
          const rel = e.ts < s.startedAt ? `-${formatClock(s.startedAt - e.ts)}` : formatClock(e.ts - s.startedAt);
          const text = esc(m.timeline[i]?.text ?? e.type);
          return `<div class="tl ${e.type} ${e.ts < s.startedAt ? 'pre' : ''}" data-i="${i}"><span class="t">${rel}</span><span class="ic">${icon(TL_ICON[e.type] ?? 'info')}</span><span class="tx">${text}</span></div>`;
        }).join('') || '<div class="muted small" style="padding:10px">No events.</div>'}</div></section>
      ${ev.shots.length ? `<section class="card panelcard"><h2>${icon('image')}Screenshots<span class="sp small faint">${ev.shots.length}</span></h2><div class="gallery">${ev.shots.map((sh, i) => `<a class="shot" href="${shotUrls[i]}" data-shot="${i}"><img src="${shotUrls[i]}" alt="screenshot ${i + 1}"><div><span>${sh.markerOrdinal ? `Marker ${sh.markerOrdinal}` : `Shot ${i + 1}`}</span><span class="num">${formatClock(Math.max(0, sh.ts - s.startedAt))}</span></div></a>`).join('')}</div></section>` : ''}
    </div><div class="col">
      <section class="card panelcard"><h2>${icon('file-text')}Report</h2>
        <div class="field"><label for="f-title">Title</label><input class="input" type="text" id="f-title" value="${esc(ev.report.title)}"></div>
        <div class="field"><label for="f-sev">Severity</label><input class="input" type="text" id="f-sev" value="${esc(ev.report.severity)}" placeholder="e.g. Major"></div>
        <div class="field"><label for="f-actual">Actual result</label><textarea class="input" id="f-actual" placeholder="What happened?">${esc(ev.report.actual)}</textarea></div>
        <div class="field"><label for="f-exp">Expected result</label><textarea class="input" id="f-exp" placeholder="What should have happened? (always written by you)">${esc(ev.report.expected)}</textarea></div>
        <div class="field" style="margin:0"><label for="f-notes">Notes</label><textarea class="input" id="f-notes" placeholder="Optional">${esc(ev.report.notes)}</textarea></div></section>
      <section class="card panelcard"><h2>${icon('list-checks')}Steps to reproduce<span class="sp small faint">draft · observed actions only</span></h2>
        ${m.steps.length ? `<ol class="steps">${m.steps.slice(0, 40).map((st) => `<li><span>${esc(st.text)}</span><span class="rel">${st.rel}</span></li>`).join('')}</ol>` : '<p class="muted small">No actions were recorded.</p>'}</section>
      ${markers.length ? `<section class="card panelcard"><h2>${icon('flag')}Markers</h2><div class="markers">${markers.map((e) => `<div class="markrow">${icon('flag')}<input class="input" type="text" data-marker="${e.id}" value="${esc(e.label ?? '')}"><span class="small faint num">${formatClock(Math.max(0, e.ts - s.startedAt))}</span></div>`).join('')}</div></section>` : ''}
      <section class="card panelcard"><h2>${icon('download')}Export</h2>
        <div class="formats">${FORMATS.map((f) => `<label class="fmt"><input type="checkbox" data-fmt="${f.id}" ${f.on ? 'checked' : ''} aria-label="${f.name}">${icon(f.icon)}<b>${f.name}</b><span>${f.sub}</span><i class="tick">${icon('check')}</i></label>`).join('')}</div>
        <div class="field" style="margin:14px 0 0"><label for="fname">File name</label><input class="input" type="text" id="fname" value="Bug-{date}_{time}"><span class="hint" id="fprev"></span></div>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap"><button class="btn primary" id="export" style="flex:1">${icon('download')}Export selected</button><button class="btn" id="cpmd">${icon('copy')}Markdown</button><button class="btn" id="cptxt">${icon('copy')}Text</button></div>
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

  function wire(m: ReportModel): void {
    const vid = document.getElementById('vid') as HTMLVideoElement | null;
    const tl = document.getElementById('tl');
    const events = visibleEvents();
    tl?.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null;
      if (!row || !vid || !video) return;
      vid.currentTime = Math.max(0, (events[Number(row.dataset.i)].ts - video.startWall) / 1000);
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

    const rebuild = async () => {
      readFields();
      await saveReport(ev.report);
      return model();
    };
    const copy = async (kind: 'md' | 'txt') => {
      const mm = await rebuild();
      await navigator.clipboard.writeText(kind === 'md' ? renderMarkdown(mm) : renderTxt(mm));
      setStatus([`<div class="r okr">${icon('check')}Copied as ${kind === 'md' ? 'Markdown' : 'plain text'}</div>`]);
    };
    const setStatus = (rows: string[]) => {
      exportNote = rows.join('');
      document.getElementById('exstatus')!.innerHTML = exportNote;
    };
    document.getElementById('cpmd')!.addEventListener('click', () => void copy('md'));
    document.getElementById('cptxt')!.addEventListener('click', () => void copy('txt'));

    document.getElementById('export')!.addEventListener('click', async () => {
      const mm = await rebuild();
      const fmts = [...document.querySelectorAll<HTMLInputElement>('[data-fmt]')].filter((c) => c.checked).map((c) => c.dataset.fmt!);
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
            blob = await buildEvidencePackage({
              model: mm, session: ev.session, events: ev.events, shots: ev.shots, video, keepPre, version: VERSION,
              videoBytes: video ? new Uint8Array(await video.blob.arrayBuffer()) : undefined,
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
