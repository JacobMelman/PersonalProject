// Console & network log ("DevTools capture"): pure helpers for what the page recorder hands over (spec: opt-in, local, filtered).
// Everything that arrives from the page is untrusted text. It is reduced to a fixed shape, every field is bounded, a fixed set of
// secret patterns is redacted, URLs lose query values and fragments, and nothing else is kept: no request or response bodies, no
// headers, no cookies. Deterministic, no AI, no heuristics that "decide" what is safe.

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogSource = 'console' | 'exception' | 'rejection';
export type NetKind = 'document' | 'fetch' | 'xhr' | 'resource';

export interface ConsoleEntry {
  level: LogLevel;
  source: LogSource;
  text: string;
  /** Top frames of a stack trace, already filtered. */
  stack?: string;
}

export interface NetEntry {
  kind: NetKind;
  /** Empty when the browser does not say (resource timing). */
  method: string;
  /** origin + path; query values and the fragment are never kept (parameter names are). */
  url: string;
  /** HTTP status; 0 = unknown (cross-origin resource timing) or failed (see `error`). */
  status: number;
  /** Time to the response headers (fetch / XHR) or the whole load (resources), ms. */
  ms: number;
  /** Bytes as the browser reported them, when it did. */
  size?: number;
  /** What loaded it, for resources: script, img, css, link, beacon ... */
  initiator?: string;
  /** Why the request failed without a status: "failed", "aborted", "timeout". */
  error?: string;
}

/** What the page recorder sends (JSON over a DOM event): never trusted, always passed through `sanitizeRaw`. `drop` counts entries
 *  the recorder had to discard (its queue was full). */
export type RawLog =
  | { k: 'drop'; n: number }
  | { k: 'c'; ts: number; level: string; source?: string; args: unknown[]; stack?: string }
  | { k: 'n'; ts: number; kind: string; method?: string; url: string; status?: number; ms?: number; size?: number; initiator?: string; error?: string };

export const LOG_LIMITS = {
  text: 1000,
  stackLines: 8,
  stack: 1500,
  url: 400,
  perBatch: 200,
  perMinute: 1200,
  /** Entries older than this when they arrive are ignored (resource timing can go back to the page load). */
  maxAgeMs: 60_000,
} as const;

/** Bumped whenever the redaction rules change; written into the Evidence Package manifest. */
export const REDACTION_RULES = 'devlog-patterns-v1';

// ---------------------------------------------------------------- redaction
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g;
const AUTH_HEADER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Card-like digit runs (IIN starts with 2-6, so millisecond timestamps never match), kept unless the Luhn check passes.
const CARD = /(?<![\d.])[2-6](?:[ -]?\d){12,18}(?![\d.])/g;
// 32+ character tokens that mix letters and digits, not inside a path or file name (bundle hashes stay readable in stack traces).
const LONG_SECRET = /(?<![\w/.-])(?=[A-Za-z0-9_+/-]*\d)(?=[A-Za-z0-9_+/-]*[A-Za-z])[A-Za-z0-9_+/-]{32,}={0,2}(?![\w/.-])/g;
// key: value / key=value / "key":"value" where the key names a secret. Long key words may have a prefix or suffix (x_auth_token,
// passwordConfirm); short ones must stand alone (pin, otp) so "spinner" or "shopping" are never touched.
const SECRET_KEY = String.raw`[\w.-]*?(?:password|passwd|passphrase|secret|token|api[_-]?key|apikey|authorization|session[_-]?id|sessid|cookie|credential|private[_-]?key|card[_-]?number|cardnumber|iban)[\w.-]*|auth|pin|otp|cvv|cvc|ssn|sid|pwd|pass`;
const KEY_VALUE = new RegExp(String.raw`(["']?)\b(${SECRET_KEY})\b\1(\s*[:=]\s*)("[^"]*"|'[^']*'|(?:Bearer|Basic|Token)\s+[^\s,;&}\])]+|[^\s,;&}\])]+)`, 'gi');

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Redacts the fixed secret patterns in free text (console messages, stack traces, URL paths). */
export function redactText(s: string): string {
  return s
    .replace(JWT, '[jwt]')
    .replace(KEY_VALUE, (_m, q: string, key: string, sep: string, val: string) => {
      const quote = val[0] === '"' || val[0] === "'" ? val[0] : '';
      return `${q}${key}${q}${sep}${quote}[redacted]${quote}`;
    })
    .replace(AUTH_HEADER, (_m, scheme: string) => `${scheme} [token]`)
    .replace(EMAIL, '[email]')
    .replace(CARD, (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[card]' : m;
    })
    .replace(LONG_SECRET, '[secret]');
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
const oneLine = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');

// ---------------------------------------------------------------- URLs
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A request URL as it is kept: origin + path (token- and id-looking segments masked, secrets redacted) + the query's parameter
 * NAMES with their values dropped. The fragment is never kept. `data:` and `blob:` URLs keep only their scheme.
 */
export function cleanRequestUrl(href: string, base?: string): string {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return '(invalid URL)';
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return `${u.protocol}…`;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol}…`;
  const path = u.pathname
    .split('/')
    .map((seg) => {
      let d = seg;
      try {
        d = decodeURIComponent(seg);
      } catch {
        /* keep it encoded */
      }
      if (UUID.test(d)) return ':id';
      if (d.length >= 24 && /\d/.test(d) && /[A-Za-z]/.test(d) && !/\.\w{1,5}$/.test(d)) return ':token';
      const r = redactText(d);
      return r === d ? seg : encodeURIComponent(r).replace(/%5B/g, '[').replace(/%5D/g, ']');
    })
    .join('/');
  const names = [...new Set([...u.searchParams.keys()])].slice(0, 12).map((k) => clip(k.replace(/[^\w.[\]-]/g, ''), 40)).filter(Boolean);
  const query = names.length ? '?' + names.map((k) => `${k}=…`).join('&') : '';
  return clip(u.origin + (path || '/') + query, LOG_LIMITS.url);
}

/** URLs inside free text (stack traces, messages) lose their query and fragment; a trailing :line:column stays. */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s()'"<>]+/g;
export const stripUrlQueries = (s: string): string =>
  s.replace(URL_IN_TEXT, (u) => {
    const pos = /(:\d+(?::\d+)?)$/.exec(u);
    const tail = pos ? pos[1] : '';
    const body = tail ? u.slice(0, -tail.length) : u;
    const cut = body.search(/[?#]/);
    return (cut >= 0 ? body.slice(0, cut) : body) + tail;
  });

// ---------------------------------------------------------------- entries
const LEVELS: Record<string, LogLevel> = { error: 'error', warn: 'warn', warning: 'warn', log: 'info', info: 'info', debug: 'debug', trace: 'debug', assert: 'error' };
const SOURCES: LogSource[] = ['console', 'exception', 'rejection'];
const KINDS: NetKind[] = ['document', 'fetch', 'xhr', 'resource'];
const METHOD = /^[A-Z]{3,7}$/;
const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);

/** Message text as kept: arguments joined, URLs without queries, secrets redacted, one bounded string. */
export function cleanMessage(args: unknown[]): string {
  const parts = (Array.isArray(args) ? args : []).slice(0, 20).map((a) => (typeof a === 'string' ? a : a === undefined ? 'undefined' : JSON.stringify(a) ?? String(a)));
  const joined = clip(parts.join(' '), LOG_LIMITS.text * 4);
  return clip(oneLine(redactText(stripUrlQueries(joined))).replace(/\s+/g, ' ').trim(), LOG_LIMITS.text);
}

export function cleanStack(stack: unknown): string | undefined {
  if (typeof stack !== 'string' || !stack.trim()) return undefined;
  const lines = stack.split('\n').map((l) => l.trim()).filter((l) => /^at\s|@/.test(l)).slice(0, LOG_LIMITS.stackLines);
  if (!lines.length) return undefined;
  return clip(lines.map((l) => oneLine(redactText(stripUrlQueries(l)))).join('\n'), LOG_LIMITS.stack);
}

export type CleanLog = { ts: number; console: ConsoleEntry } | { ts: number; net: NetEntry };

/**
 * One raw item from the page reduced to what is kept, or null when it is malformed, too old or from before capture began.
 * `now` is the arrival time; `notBefore` the moment capture began (nothing earlier is recorded).
 */
export function sanitizeRaw(raw: unknown, pageUrl: string, now: number, notBefore: number): CleanLog | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ts = num(r.ts, 0, Number.MAX_SAFE_INTEGER);
  if (ts === undefined || ts < notBefore || ts > now + 5_000 || now - ts > LOG_LIMITS.maxAgeMs) return null;
  if (r.k === 'c') {
    const level = LEVELS[String(r.level)];
    if (!level) return null;
    const source = SOURCES.includes(r.source as LogSource) ? (r.source as LogSource) : 'console';
    const text = cleanMessage(r.args as unknown[]);
    const stack = cleanStack(r.stack);
    if (!text && !stack) return null;
    return { ts: Math.round(ts), console: { level, source, text: text || '(empty message)', ...(stack ? { stack } : {}) } };
  }
  if (r.k === 'n') {
    if (typeof r.url !== 'string' || !r.url) return null;
    const kind = KINDS.includes(r.kind as NetKind) ? (r.kind as NetKind) : 'resource';
    const method = typeof r.method === 'string' && METHOD.test(r.method.toUpperCase()) ? r.method.toUpperCase() : '';
    const status = Math.round(num(r.status, 0, 999) ?? 0);
    const size = num(r.size, 0, 1e12);
    const initiator = typeof r.initiator === 'string' && /^[a-z-]{1,24}$/.test(r.initiator) ? r.initiator : undefined;
    const error = ['failed', 'aborted', 'timeout'].includes(String(r.error)) ? String(r.error) : undefined;
    return {
      ts: Math.round(ts),
      net: { kind, method, url: cleanRequestUrl(r.url, pageUrl), status, ms: Math.round(num(r.ms, 0, 3_600_000) ?? 0), ...(size ? { size: Math.round(size) } : {}), ...(initiator ? { initiator } : {}), ...(error ? { error } : {}) },
    };
  }
  return null;
}

// ---------------------------------------------------------------- reading the log
/** Console errors, uncaught exceptions, rejected promises and failed requests: what a report should point at. */
export function isConsoleProblem(c: ConsoleEntry): boolean {
  return c.level === 'error' || c.source !== 'console';
}
export function isNetProblem(n: NetEntry): boolean {
  return n.status >= 400 || !!n.error;
}

const SOURCE_LABEL: Record<LogSource, string> = { console: '', exception: 'Uncaught ', rejection: 'Unhandled rejection: ' };
export function consoleText(c: ConsoleEntry): string {
  return `${SOURCE_LABEL[c.source]}${c.text}`;
}
export function netStatus(n: NetEntry): string {
  if (n.error) return n.error;
  return n.status ? String(n.status) : '—';
}
export function netText(n: NetEntry): string {
  return `${n.method ? n.method + ' ' : ''}${n.url} → ${netStatus(n)}${n.ms ? ` (${n.ms} ms)` : ''}`;
}

/** How many entries the page recorder says it discarded in this batch (a bounded, non-negative integer). */
export function droppedInBatch(items: unknown[]): number {
  let n = 0;
  for (const r of items) if (r && typeof r === 'object' && (r as { k?: unknown }).k === 'drop') n += Math.min(1e6, Math.max(0, Math.floor(Number((r as { n?: unknown }).n) || 0)));
  return n;
}

/** Per-minute budget so a page that logs in a loop cannot flood the store. */
export class LogBudget {
  private windowStart = 0;
  private used = 0;
  dropped = 0;
  constructor(private perMinute: number = LOG_LIMITS.perMinute) {}
  /** How many of `n` new entries may be kept now. */
  take(n: number, now: number): number {
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.used = 0;
    }
    const ok = Math.max(0, Math.min(n, this.perMinute - this.used));
    this.used += ok;
    this.dropped += n - ok;
    return ok;
  }
}

// ---------------------------------------------------------------- HAR
export interface HarInput {
  ts: number;
  net: NetEntry;
}

/**
 * A HAR 1.2 log of the requests (opens in Chrome DevTools: Network → Import HAR). Only what ReproDesk keeps is in it: no headers,
 * cookies or bodies, query values replaced by "…". `_resourceType`, `_error` and `_reprodesk` are HAR custom fields.
 */
export function buildHar(entries: HarInput[], creatorVersion: string, pageTitle: string, startedAt: number): object {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  return {
    log: {
      version: '1.2',
      creator: { name: 'ReproDesk', version: creatorVersion },
      pages: [{ startedDateTime: new Date(startedAt).toISOString(), id: 'page_1', title: pageTitle, pageTimings: {} }],
      entries: sorted.map(({ ts, net }) => {
        const query = net.url.includes('?') ? net.url.slice(net.url.indexOf('?') + 1).split('&').map((p) => ({ name: p.replace(/=…$/, ''), value: '…' })) : [];
        return {
          pageref: 'page_1',
          startedDateTime: new Date(ts).toISOString(),
          time: net.ms,
          request: { method: net.method || 'GET', url: net.url, httpVersion: '', cookies: [], headers: [], queryString: query, headersSize: -1, bodySize: -1 },
          response: { status: net.status, statusText: net.error ?? '', httpVersion: '', cookies: [], headers: [], content: { size: net.size ?? -1, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: -1 },
          cache: {},
          timings: { send: 0, wait: net.ms, receive: 0 },
          _resourceType: net.kind === 'resource' ? (net.initiator ?? 'other') : net.kind,
          ...(net.error ? { _error: net.error } : {}),
        };
      }),
      comment: 'Recorded by ReproDesk: request metadata only. Query values, headers, cookies and bodies are never collected.',
    },
  };
}
