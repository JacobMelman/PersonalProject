import type { ReportModel } from './model';
import { formatClock } from '../shared/filename';
import { logo } from '../ui/brand';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function b64(data: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < data.length; i += CH) s += String.fromCharCode(...data.subarray(i, i + CH));
  return btoa(s);
}

const CSS = `
:root{color-scheme:light dark;--bg:#f4f6fa;--card:#fff;--line:#e2e7ef;--text:#0e1a2b;--muted:#51607a;--faint:#8491a7;--brand:#3558f5;--soft:#e9edff;--amber:#c97500;--red:#e5384a;--green:#12a150}
@media (prefers-color-scheme:dark){:root{--bg:#0a0e14;--card:#121820;--line:#222d3a;--text:#e9eff7;--muted:#9aabc0;--faint:#6c7d93;--brand:#6b86ff;--soft:#1b2447;--amber:#ffb547;--red:#ff6b7a;--green:#3ddc84}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:940px;margin:0 auto;padding:34px 22px 60px}
.hd{display:flex;align-items:center;gap:11px;margin-bottom:26px}.hd b{font-size:15px;letter-spacing:-.2px}.hd .gen{margin-left:auto;color:var(--faint);font-size:12.5px}
h1{font-size:30px;line-height:1.18;letter-spacing:-.8px;margin:0 0 12px;font-weight:760}
h2{font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:var(--faint);margin:34px 0 12px;font-weight:700}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:20px}.chip{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:99px;border:1px solid var(--line);background:var(--card);font-size:12.5px;color:var(--muted);font-weight:550}
.chip.ok{color:var(--green)}.chip.bad{color:var(--red)}
.callout{padding:13px 16px;border-radius:14px;border:1px solid color-mix(in srgb,var(--red) 40%,var(--line));background:color-mix(in srgb,var(--red) 8%,var(--card));margin-bottom:16px;font-size:14px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:6px 0 4px}.stat{padding:14px 16px;border-radius:14px;background:var(--card);border:1px solid var(--line)}
.stat b{display:block;font-size:26px;letter-spacing:-.7px;line-height:1.1;font-variant-numeric:tabular-nums}.stat span{font-size:12.5px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px}
ol.steps{list-style:none;counter-reset:s;margin:0;padding:0;display:grid;gap:11px}
ol.steps li{counter-increment:s;display:grid;grid-template-columns:28px 1fr auto;gap:12px;align-items:start}
ol.steps li::before{content:counter(s);display:grid;place-items:center;width:24px;height:24px;border-radius:99px;background:var(--soft);color:var(--brand);font-weight:700;font-size:12px}
.t{color:var(--faint);font-variant-numeric:tabular-nums;font-size:12.5px;padding-top:2px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}.two h3{margin:0 0 6px;font-size:13px;color:var(--muted);font-weight:650}.two p,pre{margin:0;white-space:pre-wrap;font:inherit}
.exp h3{color:var(--green)}.act h3{color:var(--red)}
.moments{display:grid;gap:0;position:relative;margin:0;padding:0;list-style:none}
.moments li{display:grid;grid-template-columns:54px 18px 1fr;gap:10px;padding:7px 0;position:relative}
.moments li::after{content:'';position:absolute;left:63px;top:26px;bottom:-7px;width:1.5px;background:var(--line)}.moments li:last-child::after{display:none}
.moments .dot{width:10px;height:10px;border-radius:50%;background:var(--amber);margin:6px 0 0 4px;position:relative;z-index:1}.moments .sys .dot{background:var(--faint)}.moments .sys{color:var(--muted);font-style:italic}
.muted{color:var(--muted)}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px}
figure{margin:0;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--card)}figure img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;object-position:top}
figcaption{display:flex;justify-content:space-between;padding:8px 12px;font-size:12.5px;color:var(--muted)}
video{width:100%;border-radius:14px;background:#05070b;border:1px solid var(--line)}
footer{margin-top:44px;padding-top:16px;border-top:1px solid var(--line);color:var(--faint);font-size:12.5px;display:flex;gap:10px;align-items:flex-start}
@media (max-width:640px){.stats{grid-template-columns:repeat(2,1fr)}.two{grid-template-columns:1fr}}
@media print{body{background:#fff}.card,figure,.stat{break-inside:avoid;box-shadow:none}video{display:none}}`;

/** assets: 'inline' embeds screenshots as data URIs (standalone file); 'zip' references files inside the Evidence Package. */
export function renderHtml(m: ReportModel, assets: 'inline' | 'zip'): string {
  const shots = m.screenshots
    .map((s) => {
      const src = assets === 'inline' && s.data ? `data:image/png;base64,${b64(s.data)}` : s.filename;
      return `<figure><a href="${esc(src)}"><img src="${esc(src)}" alt="${esc(s.label)}" loading="lazy"></a><figcaption><span>${esc(s.label)}</span><span class="t">${esc(s.rel)}</span></figcaption></figure>`;
    })
    .join('');
  const video = m.video
    ? assets === 'zip'
      ? `<video controls src="${esc(m.video.filename)}"></video><p class="muted" style="font-size:12.5px">${esc(m.video.codec)} · ${m.video.width}×${m.video.height} · ${formatClock(m.video.durationMs)}</p>`
      : `<div class="card"><span class="muted">Replay video <code>${esc(m.video.filename)}</code> is included in the Evidence Package.</span></div>`
    : `<div class="card"><span class="muted">Video not available${m.videoNote ? `: ${esc(m.videoNote)}` : ''}.</span></div>`;
  const when = new Date(m.startedAt);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.title)}</title><style>${CSS}</style></head><body><div class="wrap">
<div class="hd">${logo(30)}<b>ReproDesk</b><span class="gen">Bug report · generated ${esc(new Date().toLocaleString())}</span></div>
<h1>${esc(m.title)}</h1>
<div class="chips"><span class="chip">${esc(m.sessionType)}</span>${m.status === 'finished' ? '<span class="chip ok">Saved</span>' : m.status === 'target_ended' ? '<span class="chip bad">Target ended</span>' : '<span class="chip">' + esc(m.status) + '</span>'}<span class="chip">${esc(m.target)}</span><span class="chip">${esc(m.environment)}</span><span class="chip">${esc(m.browser)}</span><span class="chip">${esc(when.toLocaleString())}</span>${m.severity ? `<span class="chip bad">Severity: ${esc(m.severity)}</span>` : ''}</div>
${m.endNote ? `<div class="callout">${esc(m.endNote)}</div>` : ''}
<div class="stats"><div class="stat"><b>${m.durationMs != null ? formatClock(m.durationMs) : '—'}</b><span>Duration</span></div><div class="stat"><b>${m.steps.length}</b><span>Steps</span></div><div class="stat"><b>${m.moments.filter((x) => !x.system).length}</b><span>Markers</span></div><div class="stat"><b>${m.screenshots.length}</b><span>Screenshots</span></div></div>
<h2>Steps to reproduce <span style="text-transform:none;letter-spacing:0;font-weight:500">· draft from observed actions</span></h2>
<div class="card">${m.preSession.present ? `<p class="muted" style="margin:0 0 12px;font-size:13px">Pre-session context (${m.preSession.seconds}s) is ${m.preSession.kept ? 'kept as separate context' : 'removed'} and is not part of these steps.</p>` : ''}${m.steps.length ? `<ol class="steps">${m.steps.map((s) => `<li><span>${esc(s.text)}</span><span class="t">${esc(s.rel)}</span></li>`).join('')}</ol>` : '<span class="muted">No actions recorded.</span>'}</div>
<h2>Result</h2><div class="two"><div class="card exp"><h3>Expected</h3><p>${m.expected ? esc(m.expected) : '<span class="muted">not provided</span>'}</p></div><div class="card act"><h3>Actual</h3><p>${m.actual ? esc(m.actual) : '<span class="muted">not provided</span>'}</p></div></div>
${m.notes ? `<h2>Notes</h2><div class="card"><pre>${esc(m.notes)}</pre></div>` : ''}
<h2>Important moments</h2><div class="card">${m.moments.length ? `<ul class="moments">${m.moments.map((x) => `<li class="${x.system ? 'sys' : ''}"><span class="t">${esc(x.rel)}</span><span class="dot"></span><span>${esc(x.label)}${x.note ? ` <span class="muted">· ${esc(x.note)}</span>` : ''}</span></li>`).join('')}</ul>` : '<span class="muted">None recorded.</span>'}</div>
<h2>Replay</h2>${video}
<h2>Screenshots</h2>${shots ? `<div class="gallery">${shots}</div>` : '<div class="card"><span class="muted">None.</span></div>'}
<footer><span>⚠</span><span>Rendered pixels may contain sensitive values visible in the tested application. ReproDesk never collects keystrokes, clipboard contents or typed values, but the video shows what was on screen. Review before sharing.</span></footer>
</div></body></html>`;
}
