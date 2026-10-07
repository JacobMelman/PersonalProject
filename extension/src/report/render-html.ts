import type { ReportModel } from './model';
import { formatClock } from '../shared/filename';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function b64(data: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < data.length; i += CH) s += String.fromCharCode(...data.subarray(i, i + CH));
  return btoa(s);
}

/** assets: 'inline' embeds screenshots as data URIs (standalone file); 'zip' references files inside the Evidence Package. */
export function renderHtml(m: ReportModel, assets: 'inline' | 'zip'): string {
  const shots = m.screenshots
    .map((s) => {
      const src = assets === 'inline' && s.data ? `data:image/png;base64,${b64(s.data)}` : s.filename;
      return `<figure><a href="${esc(src)}"><img src="${esc(src)}" alt="${esc(s.label)}" loading="lazy"></a><figcaption>${esc(s.label)} <span class="t">${esc(s.rel)}</span></figcaption></figure>`;
    })
    .join('');
  const video = m.video
    ? assets === 'zip'
      ? `<video controls src="${esc(m.video.filename)}" style="max-width:100%"></video><p class="muted">${esc(m.video.codec)} ${m.video.width}x${m.video.height}, ${formatClock(m.video.durationMs)}</p>`
      : `<p>Replay video <code>${esc(m.video.filename)}</code> is included in the Evidence Package.</p>`
    : `<p class="muted">Video not available${m.videoNote ? `: ${esc(m.videoNote)}` : ''}.</p>`;
  const li = (items: string[]) => (items.length ? `<ol>${items.map((i) => `<li>${i}</li>`).join('')}</ol>` : '<p class="muted">None recorded.</p>');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.title)}</title>
<style>
:root{--fg:#1d2733;--muted:#5b6672;--line:#d9dee4;--accent:#183b56;--bg:#fff}
@media (prefers-color-scheme:dark){:root{--fg:#e8edf2;--muted:#9aa5b1;--line:#33404d;--accent:#8cc4ee;--bg:#14191f}}
body{font:15px/1.5 system-ui,Segoe UI,Arial,sans-serif;color:var(--fg);background:var(--bg);max-width:920px;margin:24px auto;padding:0 16px}
h1{font-size:22px;color:var(--accent)} h2{font-size:16px;margin-top:28px;border-bottom:1px solid var(--line);padding-bottom:4px;color:var(--accent)}
table{border-collapse:collapse;width:100%} td{padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top} td:first-child{width:130px;color:var(--muted)}
.muted,.t{color:var(--muted)} .note{border-left:4px solid #b45309;padding:6px 12px;background:rgba(180,83,9,.1)}
figure{margin:12px 0} img{max-width:100%;border:1px solid var(--line)} pre{white-space:pre-wrap}
code{background:rgba(127,127,127,.15);padding:0 4px;border-radius:3px}
</style></head><body>
<h1>${esc(m.title)}</h1>
${m.endNote ? `<p class="note">${esc(m.endNote)}</p>` : ''}
<table>
<tr><td>Type</td><td>${esc(m.sessionType)}</td></tr><tr><td>Environment</td><td>${esc(m.environment)}</td></tr>
<tr><td>Target</td><td>${esc(m.target)}</td></tr><tr><td>Browser</td><td>${esc(m.browser)}</td></tr>
<tr><td>Started</td><td>${esc(new Date(m.startedAt).toLocaleString())}</td></tr><tr><td>Duration</td><td>${m.durationMs != null ? formatClock(m.durationMs) : 'n/a'}</td></tr>
${m.severity ? `<tr><td>Severity</td><td>${esc(m.severity)}</td></tr>` : ''}
</table>
<h2>Steps to reproduce <span class="muted">(draft from observed actions)</span></h2>
${m.preSession.present ? `<p class="muted">Pre-session Context (${m.preSession.seconds}s) is ${m.preSession.kept ? 'kept as separate context' : 'removed'}; it is not part of these steps.</p>` : ''}
${li(m.steps.map((s) => `<span class="t">[${esc(s.rel)}]</span> ${esc(s.text)}`))}
<h2>Expected result</h2><pre>${esc(m.expected) || '<span class="muted">not provided</span>'}</pre>
<h2>Actual result</h2><pre>${esc(m.actual) || '<span class="muted">not provided</span>'}</pre>
${m.notes ? `<h2>Notes</h2><pre>${esc(m.notes)}</pre>` : ''}
<h2>Important moments</h2>
${li(m.moments.map((x) => `<span class="t">[${esc(x.rel)}]</span> ${x.system ? '<em>(system)</em> ' : ''}${esc(x.label)}${x.note ? ` <span class="muted">- ${esc(x.note)}</span>` : ''}`))}
<h2>Replay</h2>${video}
<h2>Screenshots</h2>${shots || '<p class="muted">None.</p>'}
<p class="muted">Rendered pixels may contain sensitive values visible in the tested application. Review before sharing.</p>
</body></html>`;
}
