import { describe, expect, it } from 'vitest';
import { History, hit, make, move, movePoint, pick, sanitize, hasRedaction, textBox } from '../../src/shared/annotations';

const W = 1000, H = 500;
describe('annotation geometry', () => {
  it('normalises and clamps', () => {
    const a = make('rect', -0.2, 0.1, 1.4, 0.9, '#f00');
    expect([a.x1, a.x2]).toEqual([0, 1]);
  });
  it('hit-tests shapes, handles and thin lines', () => {
    const r = make('rect', 0.2, 0.2, 0.6, 0.6, '#f00');
    expect(hit(r, 0.4, 0.4, W, H)).toBe('body');
    expect(hit(r, 0.2, 0.2, W, H)).toBe('p1');
    expect(hit(r, 0.9, 0.9, W, H)).toBeNull();
    const l = make('arrow', 0.1, 0.1, 0.9, 0.1, '#f00');
    expect(hit(l, 0.5, 0.1, W, H)).toBe('body');
    expect(hit(l, 0.5, 0.3, W, H)).toBeNull();
  });
  it('picks the topmost annotation', () => {
    const list = [make('rect', 0, 0, 1, 1, '#f00'), make('blur', 0.4, 0.4, 0.6, 0.6, '#000')];
    expect(pick(list, 0.5, 0.5, W, H)?.index).toBe(1);
    expect(pick(list, 0.05, 0.9, W, H)?.index).toBe(0);
  });
  it('moves inside the image and resizes by handle', () => {
    const r = make('rect', 0.8, 0.8, 0.95, 0.95, '#f00');
    const m = move(r, 0.5, 0.5);
    expect(m.x2).toBeLessThanOrEqual(1);
    expect(m.x2 - m.x1).toBeCloseTo(0.15);
    expect(movePoint(r, 'p2', 2, -1)).toMatchObject({ x2: 1, y2: 0 });
  });
  it('text hit box grows with the text', () => {
    const a = make('text', 0.1, 0.1, 0.1, 0.1, '#f00', 'Hello');
    const b = make('text', 0.1, 0.1, 0.1, 0.1, '#f00', 'Hello world, a much longer note');
    expect(textBox(b, W, H).w).toBeGreaterThan(textBox(a, W, H).w);
  });
});

describe('history', () => {
  it('undoes and redoes whole snapshots', () => {
    const h = new History([]);
    const a = make('rect', 0, 0, 0.5, 0.5, '#f00');
    h.commit([a]);
    h.commit([a, make('blur', 0.1, 0.1, 0.2, 0.2, '#000')]);
    expect(h.present).toHaveLength(2);
    expect(h.undo()).toBe(true);
    expect(h.present).toHaveLength(1);
    expect(h.redo()).toBe(true);
    expect(h.present).toHaveLength(2);
    h.undo();
    h.commit([]);
    expect(h.canRedo).toBe(false);
  });
  it('ignores no-op commits', () => {
    const h = new History([]);
    h.commit([]);
    expect(h.canUndo).toBe(false);
  });
});

describe('stored data', () => {
  it('sanitises untrusted stored annotations', () => {
    const out = sanitize([{ type: 'rect', x1: 0, y1: 0, x2: 2, y2: 1, color: '#fff' }, { type: 'evil', x1: 0, y1: 0, x2: 1, y2: 1 }, null, 5, { type: 'text', x1: 0.1, y1: 0.1, x2: 0.1, y2: 0.1, text: 'x'.repeat(500) }]);
    expect(out).toHaveLength(2);
    expect(out[0].x2).toBe(1);
    expect(out[1].text).toHaveLength(200);
    expect(sanitize('nope')).toEqual([]);
  });
  it('knows when a redaction is present', () => {
    expect(hasRedaction([make('rect', 0, 0, 1, 1, '#f00')])).toBe(false);
    expect(hasRedaction([make('blur', 0, 0, 1, 1, '#f00')])).toBe(true);
    expect(hasRedaction(undefined)).toBe(false);
  });
});
