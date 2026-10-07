// Deterministic data-minimisation filters (spec: PRIV-11, WEB-03, WEB-04). No AI, no heuristics that "decide" what is safe:
// a fixed set of patterns is redacted and everything else is dropped by default.

export const REDACTED = '[redacted]';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT = /eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g;
const DIGITS = /\d[\d\s().-]{5,}\d/g; // phone / card / account like runs (7+ digits incl. separators)
const LONG_TOKEN = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g;

/** Returns a safe, short label or null when nothing usable is left. */
export function sanitizeLabel(text: string | null | undefined, max = 80): string | null {
  if (!text) return null;
  let t = text.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  t = t.replace(JWT, REDACTED).replace(EMAIL, REDACTED).replace(LONG_TOKEN, REDACTED).replace(DIGITS, REDACTED);
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t;
}

/** Only short, name-like ids / data-testid values survive; uuid/hex/numeric-looking ids are dropped. */
export function sanitizeStableId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (!/^[A-Za-z][\w:.-]{0,48}$/.test(id)) return null;
  if (/[0-9a-f]{12,}/i.test(id.replace(/[-_]/g, ''))) return null;
  if ((id.match(/\d/g) ?? []).length >= 6) return null;
  return id;
}

export interface MinimizedUrl {
  origin: string;
  path: string;
}

/** origin + path only (query string and fragment are never stored). Token/uuid looking path segments are masked. */
export function minimizeUrl(href: string | null | undefined): MinimizedUrl | null {
  if (!href) return null;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const path = u.pathname
    .split('/')
    .map((seg) => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
      if (seg.length >= 24 && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return ':token';
      return seg;
    })
    .join('/');
  return { origin: u.origin, path: path || '/' };
}

export function isApprovedOrigin(origin: string | null | undefined, approved: string[]): boolean {
  if (!origin) return false;
  return approved.includes(origin);
}

const IMPLICIT_ROLES: Record<string, string> = {
  a: 'link',
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  img: 'img',
  nav: 'navigation',
  table: 'table',
  dialog: 'dialog',
  summary: 'button',
};

export function implicitRole(tag: string, type: string | null): string | null {
  if (tag === 'input') {
    switch (type) {
      case 'checkbox': return 'checkbox';
      case 'radio': return 'radio';
      case 'button': case 'submit': case 'reset': case 'image': return 'button';
      case 'range': return 'slider';
      case 'search': return 'searchbox';
      default: return 'textbox';
    }
  }
  return IMPLICIT_ROLES[tag] ?? null;
}

/** Elements whose visible text / value is user-editable content: their text must never be read. */
export function isEditableKind(tag: string, type: string | null, contentEditable: boolean): boolean {
  if (contentEditable) return true;
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const buttons = ['button', 'submit', 'reset', 'image', 'checkbox', 'radio'];
    return !buttons.includes(type ?? 'text');
  }
  return false;
}
