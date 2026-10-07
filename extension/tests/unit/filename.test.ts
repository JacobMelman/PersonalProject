import { describe, expect, it } from 'vitest';
import { expandTemplate, formatClock, sanitizeFilename, uniqueName } from '../../src/shared/filename';

describe('filenames', () => {
  it('sanitises illegal characters, traversal, reserved names', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('_._etc_passwd');
    expect(sanitizeFilename('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('nul.txt')).toBe('_nul.txt');
    expect(sanitizeFilename('  ...  ')).toBe('report');
    expect(sanitizeFilename('x'.repeat(300) + '.docx').length).toBeLessThanOrEqual(120);
    expect(sanitizeFilename('x'.repeat(300) + '.docx').endsWith('.docx')).toBe(true);
  });
  it('expands templates and drops unknown placeholders', () => {
    expect(expandTemplate('Bug-{date}_{time}-{app}{nope}', { date: '2026-10-07', time: '101500', app: 'qa' })).toBe('Bug-2026-10-07_101500-qa');
  });
  it('resolves collisions predictably', () => {
    const ex = new Set(['bug.zip', 'bug (2).zip']);
    expect(uniqueName('bug.zip', ex)).toBe('bug (3).zip');
    expect(uniqueName('other.zip', ex)).toBe('other.zip');
  });
  it('formats clocks', () => {
    expect(formatClock(65_000)).toBe('01:05');
    expect(formatClock(-5)).toBe('00:00');
  });
});
