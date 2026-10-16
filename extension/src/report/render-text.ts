import type { ReportModel } from './model';
import { formatClock } from '../shared/filename';

/** How many problems a text report lists; the full log is in the Evidence Package. */
export const PROBLEMS_SHOWN = 50;
export const devlogSummary = (d: NonNullable<ReportModel['devlog']>): string => {
  const errs = d.problems.filter((p) => p.kind === 'console').length;
  const failed = d.problems.filter((p) => p.kind === 'network').length;
  return `${d.console.length} console message${d.console.length === 1 ? '' : 's'} (${errs} error${errs === 1 ? '' : 's'}), ${d.network.length} request${d.network.length === 1 ? '' : 's'} (${failed} failed)`;
};

const dur = (m: ReportModel) => (m.durationMs != null ? formatClock(m.durationMs) : 'n/a');

export function renderTxt(m: ReportModel): string {
  const L: string[] = [];
  const line = (k: string, v: string) => L.push(`${k.padEnd(14)}${v}`);
  L.push(m.title, '='.repeat(Math.min(m.title.length, 80)), '');
  line('Type:', m.sessionType);
  line('Environment:', m.environment);
  line('Target:', m.target);
  line('Browser:', m.browser);
  line('Started:', new Date(m.startedAt).toLocaleString());
  line('Duration:', dur(m));
  if (m.severity) line('Severity:', m.severity);
  if (m.endNote) L.push('', `NOTE: ${m.endNote}`);
  L.push('', 'Steps to reproduce (draft, generated from observed actions)', '-'.repeat(60));
  if (m.preSession.present) L.push(`(Pre-session Context ${m.preSession.kept ? 'kept as separate context' : 'removed'}; its events are not part of these steps.)`);
  if (!m.steps.length) L.push('(no actions recorded)');
  m.steps.forEach((s) => {
    L.push(`${String(s.n).padStart(2)}. [${s.rel}] ${s.text}`);
    if (s.renamed) L.push(`    observed: ${s.observed}`);
  });
  L.push('', 'Expected result', '-'.repeat(60), m.expected || '(not provided)');
  L.push('', 'Actual result', '-'.repeat(60), m.actual || '(not provided)');
  if (m.notes) L.push('', 'Notes', '-'.repeat(60), m.notes);
  L.push('', 'Important moments', '-'.repeat(60));
  if (!m.moments.length) L.push('(none)');
  m.moments.forEach((x) => L.push(`[${x.rel}] ${x.system ? '(system) ' : ''}${x.label}${x.note ? ` - ${x.note}` : ''}`));
  if (m.devlog) {
    L.push('', 'Console errors and failed requests', '-'.repeat(60), devlogSummary(m.devlog));
    if (!m.devlog.problems.length) L.push('(none)');
    m.devlog.problems.slice(0, PROBLEMS_SHOWN).forEach((p) => L.push(`[${p.rel}] ${p.text}`));
    if (m.devlog.problems.length > PROBLEMS_SHOWN) L.push(`(${m.devlog.problems.length - PROBLEMS_SHOWN} more in the Evidence Package)`);
    L.push('Full log: console.json and network.har in the Evidence Package (no request bodies, headers, cookies or query values).');
  }
  L.push('', 'Attachments / evidence', '-'.repeat(60));
  if (m.video) L.push(`Video: ${m.video.filename} (${m.video.codec}, ${m.video.width}x${m.video.height}, ${formatClock(m.video.durationMs)}) - see the Evidence Package`);
  else L.push(`Video: not available${m.videoNote ? ` (${m.videoNote})` : ''}`);
  m.screenshots.forEach((s) => L.push(`Screenshot: ${s.filename} [${s.rel}] ${s.label} - see the Evidence Package (TXT cannot embed images)`));
  return L.join('\n') + '\n';
}

export function renderMarkdown(m: ReportModel): string {
  const L: string[] = [`# ${m.title}`, ''];
  L.push(`- **Type:** ${m.sessionType}`, `- **Environment:** ${m.environment}`, `- **Target:** ${m.target}`, `- **Browser:** ${m.browser}`, `- **Started:** ${new Date(m.startedAt).toLocaleString()}`, `- **Duration:** ${dur(m)}`);
  if (m.severity) L.push(`- **Severity:** ${m.severity}`);
  if (m.endNote) L.push('', `> ${m.endNote}`);
  L.push('', '## Steps to reproduce', '');
  if (!m.steps.length) L.push('_No actions recorded._');
  m.steps.forEach((s) => L.push(`${s.n}. \`${s.rel}\` ${s.text}${s.renamed ? ` (observed: ${s.observed})` : ''}`));
  L.push('', '## Expected result', '', m.expected || '_not provided_', '', '## Actual result', '', m.actual || '_not provided_');
  if (m.notes) L.push('', '## Notes', '', m.notes);
  if (m.moments.length) {
    L.push('', '## Important moments', '');
    m.moments.forEach((x) => L.push(`- \`${x.rel}\` ${x.system ? '_(system)_ ' : ''}${x.label}`));
  }
  if (m.devlog) {
    L.push('', '## Console errors and failed requests', '', `_${devlogSummary(m.devlog)}_`, '');
    if (!m.devlog.problems.length) L.push('_None._');
    m.devlog.problems.slice(0, PROBLEMS_SHOWN).forEach((p) => L.push(`- \`${p.rel}\` ${p.text.replace(/([\\`*_[\]<>|])/g, '\\$1')}`));
    if (m.devlog.problems.length > PROBLEMS_SHOWN) L.push(`- _${m.devlog.problems.length - PROBLEMS_SHOWN} more in the Evidence Package_`);
  }
  L.push('', '## Evidence', '', m.video ? `- Video: \`${m.video.filename}\`` : '- Video: not available');
  m.screenshots.forEach((s) => L.push(`- Screenshot: \`${s.filename}\` (${s.label})`));
  if (m.devlog) L.push('- Console & network log: `console.json`, `network.har`');
  return L.join('\n') + '\n';
}
