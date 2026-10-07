// Minimal, dependency-light XLSX writer (inline strings): enough for a report sheet + steps sheet + timeline sheet.
import { strToU8, zipSync } from 'fflate';
import type { ReportModel } from './model';
import { formatClock } from '../shared/filename';

const x = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const col = (i: number) => String.fromCharCode(65 + i);

function sheet(rows: string[][], widths: number[]): string {
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const body = rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => `<c r="${col(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${x(c)}</t></is></c>`).join('')}</row>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}

export function renderXlsx(m: ReportModel): Blob {
  const meta: string[][] = [
    ['Field', 'Value'],
    ['Title', m.title], ['Type', m.sessionType], ['Environment', m.environment], ['Target', m.target], ['Browser', m.browser],
    ['Started', new Date(m.startedAt).toLocaleString()], ['Duration', m.durationMs != null ? formatClock(m.durationMs) : 'n/a'],
    ['Severity', m.severity], ['Expected result', m.expected], ['Actual result', m.actual], ['Notes', m.notes], ['Outcome note', m.endNote ?? ''],
    ['Replay video', m.video ? m.video.filename : 'not available'],
    ['Screenshots', m.screenshots.map((s) => s.filename).join('; ')],
  ];
  const steps: string[][] = [['#', 'Time', 'Step'], ...m.steps.map((s) => [String(s.n), s.rel, s.text])];
  const timeline: string[][] = [['Time', 'Type', 'Event'], ...m.timeline.map((t) => [t.rel, t.type, t.text])];
  const sheets = [['Report', meta, [24, 90]], ['Steps', steps, [6, 10, 90]], ['Timeline', timeline, [10, 12, 90]]] as const;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${s[0]}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>'),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheet(s[1] as unknown as string[][], s[2] as unknown as number[]))));
  return new Blob([zipSync(files) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
