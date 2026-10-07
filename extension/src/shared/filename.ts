const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Safe file name: strips illegal characters/path separators/reserved names/trailing dots, caps length. */
export function sanitizeFilename(name: string, max = 120): string {
  let n = name
    .replace(/[\\/]+/g, '_')
    .replace(/\.\.+/g, '.')
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!n) n = 'report';
  if (RESERVED.test(n)) n = '_' + n;
  if (n.length > max) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 8 ? n.slice(dot) : '';
    n = n.slice(0, max - ext.length) + ext;
  }
  return n;
}

export function expandTemplate(tpl: string, values: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? '');
}

export function uniqueName(name: string, existing: Set<string>): string {
  if (!existing.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10000; i++) {
    const cand = `${base} (${i})${ext}`;
    if (!existing.has(cand.toLowerCase())) return cand;
  }
  return `${base}-${Date.now()}${ext}`;
}

export function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

export function stamp(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
  };
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
