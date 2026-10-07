import { loadEvidence, saveReport, type LoadedEvidence } from '../report/evidence';
import { buildReportModel, type ReportModel } from '../report/model';
import { muxSessionVideo, type MuxedVideo } from '../report/video';
import { renderHtml } from '../report/render-html';
import { renderMarkdown, renderTxt } from '../report/render-text';
import { renderDocx } from '../report/render-docx';
import { renderXlsx } from '../report/render-xlsx';
import { buildEvidencePackage } from '../report/package';
import { expandTemplate, formatClock, sanitizeFilename, stamp, uniqueName } from '../shared/filename';
import { dbGetAll, dbPut } from '../storage/db';
import type { SessionRecord, TimelineEvent } from '../shared/types';

const app = document.getElementById('app')!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const VERSION = chrome.runtime.getManifest().version;
const sessionId = new URLSearchParams(location.search).get('session');

async function list(): Promise<void> {
  const rows = (await dbGetAll<SessionRecord>('sessions')).sort((a, b) => b.createdAt - a.createdAt);
  app.innerHTML = `<h1>ReproDesk - saved sessions</h1>${rows.length ? '' : '<p class="muted">Nothing saved yet.</p>'}` +
    rows.map((s) => `<div class="sess"><div class="meta"><b>${esc(s.kind)} - ${esc(s.status)}</b><span class="muted small">${new Date(s.startedAt).toLocaleString()} - ${esc(s.targetOrigin ?? '')}</span></div><a href="?session=${encodeURIComponent(s.id)}"><button>Open</button></a></div>`).join('');
}

async function detail(id: string): Promise<void> {
  const loaded = await loadEvidence(id);
  if (!loaded) {
    app.innerHTML = '<h1>Session not found</h1><p class="muted">It may have been deleted.</p>';
    return;
  }
  const ev: LoadedEvidence = loaded;
  let keepPre = ev.session.preContext?.kept ?? true;
  let video: MuxedVideo | null = null;
  let videoUrl = '';
  let videoErr = '';

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

  const draw = () => {
    const s = ev.session;
    const m = model();
    const pre = s.preContext;
    const events = ev.events.filter((e) => keepPre || e.ts >= s.startedAt).sort((a, b) => a.ts - b.ts);
    const classOpts = ['', 'UI/Application crashed', 'Fatal error and closed', 'Tab crashed', 'Browser closed', 'Application became unresponsive', 'Other'];
    app.innerHTML = `
    <h1>${esc(m.title)}</h1>
    <div class="muted small">${esc(m.sessionType)} - ${esc(s.status)} - ${esc(m.target)} - ${esc(m.browser)} - ${new Date(s.startedAt).toLocaleString()}${s.reviewedAt ? '' : ''}</div>
    <div class="banner">Values visible in the tested application may appear in video and screenshots even though typed values are never collected. Inspect before sharing. Evidence stays on this device until you export it.</div>
    ${m.endNote ? `<div class="banner" style="border-color:var(--danger)">${esc(m.endNote)}</div>` : ''}
    ${s.status === 'target_ended' || s.status === 'recovered' ? `<label>Outcome classification</label><select id="cls">${classOpts.map((c) => `<option ${c === (s.classification ?? '') ? 'selected' : ''}>${c}</option>`).join('')}</select><label>Comment</label><input type="text" id="clsnote" value="${esc(s.classificationNote ?? '')}">` : ''}
    <div class="cols"><div>
      <h2>Replay</h2>
      ${video ? `<video id="vid" controls src="${videoUrl}"></video><div class="muted small">${esc(video.codec)} ${video.width}x${video.height}, ${formatClock(video.durationMs)}, ${video.segments} GOP segments${video.gaps.length ? `, ${video.gaps.length} capture gap(s) (pauses)` : ''}</div>` : `<div class="banner">No video available${s.videoFailure ? `: ${esc(s.videoFailure)}` : videoErr ? `: ${esc(videoErr)}` : ''}.</div>`}
      ${pre ? `<h2>Pre-session Context</h2><div class="row"><span>${Math.round((pre.endWall - pre.startWall) / 1000)} s of evidence before Start, shown separately</span><button class="secondary" id="prekeep">${keepPre ? 'Remove it' : 'Keep it'}</button></div>` : ''}
      <h2>Timeline <span class="muted small">(raw, click to seek)</span></h2>
      <div class="tl" id="tl">${events.map((e, i) => `<div data-i="${i}" class="${e.system ? 'sys' : ''} ${e.ts < s.startedAt ? 'pre' : ''}"><span class="t">${e.ts < s.startedAt ? '-' : ''}${formatClock(Math.abs(e.ts - s.startedAt))}</span><span>${esc(m.timeline[i]?.text ?? e.type)}</span></div>`).join('') || '<div class="muted">No events.</div>'}</div>
      <h2>Screenshots</h2>
      <div class="shots">${ev.shots.map((sh, i) => `<a href="${shotUrls[i]}" target="_blank"><img src="${shotUrls[i]}" alt="screenshot ${i + 1}"><div class="muted small">${formatClock(sh.ts - s.startedAt)} ${sh.markerOrdinal ? 'Marker ' + sh.markerOrdinal : ''}</div></a>`).join('') || '<span class="muted">None.</span>'}</div>
    </div><div>
      <h2>Report</h2>
      <label>Title</label><input type="text" id="f-title" value="${esc(ev.report.title)}">
      <label>Severity</label><input type="text" id="f-sev" value="${esc(ev.report.severity)}" placeholder="e.g. Major">
      <label>Actual result</label><textarea id="f-actual">${esc(ev.report.actual)}</textarea>
      <label>Expected result (always written by you)</label><textarea id="f-exp">${esc(ev.report.expected)}</textarea>
      <label>Notes</label><textarea id="f-notes">${esc(ev.report.notes)}</textarea>
      <h2>Markers</h2>
      ${events.filter((e) => e.type === 'marker').map((e) => `<div class="row"><input type="text" data-marker="${e.id}" value="${esc(e.label ?? '')}"><span class="muted small">${formatClock(e.ts - s.startedAt)}</span></div>`).join('') || '<span class="muted">No markers.</span>'}
      <h2>Draft steps <span class="muted small">(${m.steps.length}, from observed actions only)</span></h2>
      <ol class="small">${m.steps.slice(0, 40).map((st) => `<li>[${st.rel}] ${esc(st.text)}</li>`).join('')}</ol>
      <h2>Export</h2>
      <label>File name template</label><input type="text" id="fname" value="Bug-{date}_{time}">
      <div class="muted small" id="fprev"></div>
      <div class="exports">
        ${['html', 'txt', 'md', 'docx', 'xlsx', 'zip'].map((f) => `<label><input type="checkbox" data-fmt="${f}" ${['zip', 'html'].includes(f) ? 'checked' : ''}> ${f.toUpperCase()}</label>`).join('')}
        <button id="export">Export selected</button>
      </div>
      <div class="exports"><button class="secondary" id="cpmd">Copy as Markdown</button><button class="secondary" id="cptxt">Copy as Plain Text</button></div>
      <div class="muted small" id="exstatus"></div>
      <p><button class="danger" id="del">Delete this session</button></p>
    </div></div>`;
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
    document.getElementById('tl')?.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null;
      if (!row || !vid || !video) return;
      const events = ev.events.filter((x) => keepPre || x.ts >= ev.session.startedAt).sort((a, b) => a.ts - b.ts);
      vid.currentTime = Math.max(0, (events[Number(row.dataset.i)].ts - video.startWall) / 1000);
    });
    document.getElementById('prekeep')?.addEventListener('click', async () => {
      readFields();
      keepPre = !keepPre;
      if (ev.session.preContext) {
        ev.session = { ...ev.session, preContext: { ...ev.session.preContext, kept: keepPre } };
        await dbPut('sessions', ev.session);
      }
      await buildVideo();
      draw();
    });
    ['cls', 'clsnote'].forEach((id) => document.getElementById(id)?.addEventListener('change', async () => {
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
    ['f-title', 'f-sev', 'f-actual', 'f-exp', 'f-notes'].forEach((id) => document.getElementById(id)?.addEventListener('change', async () => {
      readFields();
      await saveReport(ev.report);
    }));
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
      document.getElementById('exstatus')!.textContent = `Copied as ${kind === 'md' ? 'Markdown' : 'plain text'}.`;
    };
    document.getElementById('cpmd')!.addEventListener('click', () => void copy('md'));
    document.getElementById('cptxt')!.addEventListener('click', () => void copy('txt'));

    document.getElementById('export')!.addEventListener('click', async () => {
      const status = document.getElementById('exstatus')!;
      const mm = await rebuild();
      const fmts = [...document.querySelectorAll<HTMLInputElement>('[data-fmt]')].filter((c) => c.checked).map((c) => c.dataset.fmt!);
      if (!fmts.length) return void (status.textContent = 'Select at least one format.');
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
          const name = uniqueName(`${baseName()}.${f === 'md' ? 'md' : f}`, used);
          used.add(name.toLowerCase());
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
          results.push(`${f.toUpperCase()}: ok (${name}, ${(blob.size / 1024).toFixed(0)} KB)`);
        } catch (err) {
          results.push(`${f.toUpperCase()}: FAILED - ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      status.innerHTML = results.map(esc).join('<br>');
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

