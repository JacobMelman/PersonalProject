// Screenshot editor overlay: arrows, lines, rectangles, ellipses, text, blur and redaction on a non-destructive layer.
import { COLORS, History, bbox, make, move, movePoint, pick, sanitize, type Annotation, type AnnotationType } from '../shared/annotations';
import { drawAnnotations } from '../ui/annotate-render';
import { icon, type IconName } from '../ui/icons';
import { esc } from '../ui/format';

type Tool = 'select' | AnnotationType;
const TOOLS: Array<{ id: Tool; icon: IconName; label: string; key: string }> = [
  { id: 'select', icon: 'mouse-pointer-2', label: 'Select / move', key: 'V' },
  { id: 'arrow', icon: 'move-up-right', label: 'Arrow', key: 'A' },
  { id: 'line', icon: 'minus', label: 'Line', key: 'L' },
  { id: 'rect', icon: 'square', label: 'Rectangle', key: 'R' },
  { id: 'ellipse', icon: 'circle', label: 'Ellipse', key: 'E' },
  { id: 'text', icon: 'type', label: 'Text', key: 'T' },
  { id: 'blur', icon: 'grid-3x3', label: 'Blur (mosaic)', key: 'B' },
  { id: 'redact', icon: 'rectangle-horizontal', label: 'Redact (black box)', key: 'X' },
];

export interface EditorInput {
  original: Blob;
  annotations: Annotation[];
  title: string;
  onSave: (list: Annotation[]) => Promise<void>;
}

export async function openEditor(input: EditorInput): Promise<void> {
  const bmp = await createImageBitmap(input.original);
  const W = bmp.width, H = bmp.height;
  const hist = new History(sanitize(input.annotations));
  const startJson = JSON.stringify(hist.present);
  let tool: Tool = 'select';
  let color: string = COLORS[0];
  let selected: string | null = null;
  let draft: Annotation | null = null;
  let drag: { kind: 'move' | 'p1' | 'p2'; id: string; lx: number; ly: number } | null = null;
  let working: Annotation[] | null = null; // live preview while dragging; committed to history on release
  let textInput: HTMLTextAreaElement | null = null;

  const root = document.createElement('div');
  root.className = 'editor';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Screenshot editor');
  root.innerHTML = `<div class="editor__bar">
      <div class="editor__title">${icon('pencil')}<b>${esc(input.title)}</b></div>
      <div class="editor__tools" role="toolbar" aria-label="Tools">${TOOLS.map((t) => `<button class="tool" data-tool="${t.id}" title="${t.label} (${t.key})" aria-label="${t.label}">${icon(t.icon)}</button>`).join('')}</div>
      <div class="editor__colors" role="group" aria-label="Colour">${COLORS.map((c) => `<button class="swatch" data-color="${c}" style="--c:${c}" aria-label="Colour ${c}"></button>`).join('')}</div>
      <div class="editor__tools"><button class="tool" id="ed-undo" title="Undo (Ctrl+Z)" aria-label="Undo">${icon('undo-2')}</button><button class="tool" id="ed-redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">${icon('redo-2')}</button><button class="tool" id="ed-del" title="Delete selected (Del)" aria-label="Delete selected">${icon('trash-2')}</button><button class="tool" id="ed-reset" title="Remove all annotations" aria-label="Revert to original">${icon('rotate-ccw')}</button></div>
      <div class="editor__end"><button class="btn" id="ed-cancel">Cancel</button><button class="btn primary" id="ed-save">${icon('check')}Save</button></div>
    </div>
    <div class="editor__stage" id="ed-stage"><canvas id="ed-canvas" width="${W}" height="${H}" aria-label="Screenshot canvas"></canvas></div>
    <div class="editor__hint">${icon('shield-alert')}<span><b>Blur</b> and <b>Redact</b> remove those pixels from every exported copy. The original stays untouched on this device and is left out of exports unless you include it.</span></div>`;
  document.body.appendChild(root);
  document.body.classList.add('noscroll');
  const canvas = root.querySelector<HTMLCanvasElement>('#ed-canvas')!;
  const stage = root.querySelector<HTMLElement>('#ed-stage')!;
  const ctx = canvas.getContext('2d')!;

  const redraw = () => {
    drawAnnotations(ctx, bmp, W, H, draft ? [...(working ?? hist.present), draft] : (working ?? hist.present), { selectedId: selected, handles: true });
    root.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
    root.querySelectorAll<HTMLElement>('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === color));
    (root.querySelector('#ed-undo') as HTMLButtonElement).disabled = !hist.canUndo;
    (root.querySelector('#ed-redo') as HTMLButtonElement).disabled = !hist.canRedo;
    (root.querySelector('#ed-del') as HTMLButtonElement).disabled = !selected;
    canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
  };
  const norm = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const tol = () => Math.max(8, (W / Math.max(1, canvas.getBoundingClientRect().width)) * 8); // ~8 screen px expressed in image px
  const replace = (a: Annotation) => hist.commit(hist.present.map((x) => (x.id === a.id ? a : x)));

  function commitText(nx: number, ny: number, existing?: Annotation): void {
    if (!textInput) return;
    const value = textInput.value.trim();
    textInput.remove();
    textInput = null;
    if (value) {
      if (existing) replace({ ...existing, text: value });
      else {
        const a = make('text', nx, ny, nx, ny, color, value);
        hist.commit([...hist.present, a]);
        selected = a.id;
        tool = 'select';
      }
    }
    redraw();
  }
  function textEditor(nx: number, ny: number, existing?: Annotation): void {
    textInput?.remove();
    const ta = document.createElement('textarea');
    ta.className = 'editor__text';
    ta.placeholder = 'Type a note, Enter to add';
    ta.value = existing?.text ?? '';
    const r = canvas.getBoundingClientRect(), s = stage.getBoundingClientRect();
    ta.style.left = `${r.left - s.left + stage.scrollLeft + nx * r.width}px`;
    ta.style.top = `${r.top - s.top + stage.scrollTop + ny * r.height}px`;
    stage.appendChild(ta);
    textInput = ta;
    ta.focus(); // the canvas mousedown default is cancelled below, so the field keeps focus
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(nx, ny, existing); }
      if (e.key === 'Escape') { ta.remove(); textInput = null; redraw(); }
    });
    ta.addEventListener('blur', () => { if (textInput === ta) commitText(nx, ny, existing); });
  }

  canvas.addEventListener('mousedown', (e) => { if (tool === 'text') e.preventDefault(); });
  canvas.addEventListener('pointerdown', (e) => {
    if (textInput) { textInput.blur(); return; }
    canvas.setPointerCapture(e.pointerId);
    const p = norm(e);
    if (tool === 'select') {
      const hit = pick(hist.present, p.x, p.y, W, H, tol());
      selected = hit ? hist.present[hit.index].id : null;
      if (hit) drag = { kind: hit.part === 'body' ? 'move' : hit.part, id: hist.present[hit.index].id, lx: p.x, ly: p.y };
      redraw();
      return;
    }
    if (tool === 'text') { textEditor(p.x, p.y); return; }
    draft = make(tool, p.x, p.y, p.x, p.y, color);
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = norm(e);
    if (draft) { draft = { ...draft, x2: p.x, y2: p.y }; redraw(); return; }
    if (!drag) return;
    const base = working ?? hist.present;
    const cur = base.find((a) => a.id === drag!.id);
    if (!cur) return;
    const next = drag.kind === 'move' ? move(cur, p.x - drag.lx, p.y - drag.ly) : movePoint(cur, drag.kind, p.x, p.y);
    drag.lx = p.x;
    drag.ly = p.y;
    working = base.map((a) => (a.id === next.id ? next : a));
    redraw();
  });
  canvas.addEventListener('pointerup', (e) => {
    canvas.releasePointerCapture(e.pointerId);
    if (draft) {
      const b = bbox(draft);
      const tiny = draft.type === 'arrow' || draft.type === 'line' ? Math.hypot(b.w * W, b.h * H) < 8 : b.w * W < 8 || b.h * H < 8;
      if (!tiny) { hist.commit([...hist.present, draft]); selected = draft.id; tool = 'select'; }
      draft = null;
    }
    if (working) { hist.commit(working); working = null; }
    drag = null;
    redraw();
  });
  canvas.addEventListener('dblclick', (e) => {
    const p = norm(e as unknown as PointerEvent);
    const hit = pick(hist.present, p.x, p.y, W, H, tol());
    if (hit && hist.present[hit.index].type === 'text') textEditor(hist.present[hit.index].x1, hist.present[hit.index].y1, hist.present[hit.index]);
  });

  root.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => b.addEventListener('click', () => { tool = b.dataset.tool as Tool; if (tool !== 'select') selected = null; redraw(); }));
  root.querySelectorAll<HTMLElement>('[data-color]').forEach((b) => b.addEventListener('click', () => {
    color = b.dataset.color!;
    const cur = hist.present.find((a) => a.id === selected);
    if (cur && cur.type !== 'blur' && cur.type !== 'redact') replace({ ...cur, color });
    redraw();
  }));
  const undo = () => { if (hist.undo()) { selected = null; redraw(); } };
  const redo = () => { if (hist.redo()) { selected = null; redraw(); } };
  const del = () => { if (selected) { hist.commit(hist.present.filter((a) => a.id !== selected)); selected = null; redraw(); } };
  root.querySelector('#ed-undo')!.addEventListener('click', undo);
  root.querySelector('#ed-redo')!.addEventListener('click', redo);
  root.querySelector('#ed-del')!.addEventListener('click', del);
  root.querySelector('#ed-reset')!.addEventListener('click', () => { if (hist.present.length && confirm('Remove all annotations from this screenshot?')) { hist.commit([]); selected = null; redraw(); } });

  const close = () => {
    root.remove();
    document.body.classList.remove('noscroll');
    removeEventListener('keydown', onKey, true);
    bmp.close();
  };
  const dirty = () => JSON.stringify(hist.present) !== startJson;
  root.querySelector('#ed-cancel')!.addEventListener('click', () => { if (!dirty() || confirm('Discard your changes?')) close(); });
  root.querySelector('#ed-save')!.addEventListener('click', async () => {
    (root.querySelector('#ed-save') as HTMLButtonElement).disabled = true;
    await input.onSave(hist.present);
    close();
  });
  function onKey(e: KeyboardEvent): void {
    if (textInput) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); del(); }
    else if (e.key === 'Escape') { e.preventDefault(); (root.querySelector('#ed-cancel') as HTMLElement).click(); }
    else if (!mod) {
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (t) { tool = t.id; if (tool !== 'select') selected = null; redraw(); }
    }
  }
  addEventListener('keydown', onKey, true);
  redraw();
}
