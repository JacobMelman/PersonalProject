import { Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import type { ReportModel } from './model';
import { formatClock } from '../shared/filename';

const para = (text: string, opts: { bold?: boolean; italics?: boolean } = {}) => new Paragraph({ children: [new TextRun({ text, ...opts })] });

export async function renderDocx(m: ReportModel): Promise<Blob> {
  const row = (k: string, v: string) =>
    new TableRow({
      children: [
        new TableCell({ width: { size: 2200, type: WidthType.DXA }, children: [para(k, { bold: true })] }),
        new TableCell({ width: { size: 7160, type: WidthType.DXA }, children: [para(v)] }),
      ],
    });
  const children: Array<Paragraph | Table> = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(m.title)] }),
    ...(m.endNote ? [para(m.endNote, { italics: true })] : []),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2200, 7160],
      rows: [
        row('Type', m.sessionType), row('Environment', m.environment), row('Target', m.target), row('Browser', m.browser),
        row('Started', new Date(m.startedAt).toLocaleString()), row('Duration', m.durationMs != null ? formatClock(m.durationMs) : 'n/a'),
        ...(m.severity ? [row('Severity', m.severity)] : []),
      ],
    }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Steps to reproduce (draft from observed actions)')] }),
    ...(m.steps.length ? m.steps.map((s) => para(`${s.n}. [${s.rel}] ${s.text}`)) : [para('No actions recorded.', { italics: true })]),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Expected result')] }),
    para(m.expected || '(not provided)'),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Actual result')] }),
    para(m.actual || '(not provided)'),
    ...(m.notes ? [new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Notes')] }), para(m.notes)] : []),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Important moments')] }),
    ...(m.moments.length ? m.moments.map((x) => para(`[${x.rel}] ${x.system ? '(system) ' : ''}${x.label}${x.note ? ` - ${x.note}` : ''}`)) : [para('None.', { italics: true })]),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Screenshots and evidence')] }),
    para(m.video ? `Replay video: ${m.video.filename} (see the Evidence Package)` : `Video not available${m.videoNote ? `: ${m.videoNote}` : ''}`),
  ];
  for (const s of m.screenshots) {
    children.push(para(`${s.label} [${s.rel}]`, { bold: true }));
    if (s.data && s.width) {
      const w = Math.min(560, s.width);
      children.push(new Paragraph({ children: [new ImageRun({ type: 'png', data: s.data, transformation: { width: w, height: Math.round((w * s.height) / s.width) }, altText: { title: s.label, description: s.label, name: s.label } })] }));
    } else children.push(para(`(${s.filename} - not embedded)`, { italics: true }));
  }
  children.push(para('Rendered pixels may contain sensitive values visible in the tested application. Review before sharing.', { italics: true }));
  const doc = new Document({ creator: 'ReproDesk', title: m.title, sections: [{ properties: { page: { size: { width: 12240, height: 15840 } } }, children }] });
  return Packer.toBlob(doc);
}
