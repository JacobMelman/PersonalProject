// Page recorder for the Console & network log. Runs in the page's own JavaScript world (MAIN), because only there are the page's
// console, fetch and XMLHttpRequest visible. It only observes: every original is called unchanged, nothing is blocked or altered,
// and it never reads request or response bodies, headers or cookies. Entries go to the ReproDesk content script (isolated world)
// as JSON text over a DOM event; the service worker decides whether anything is kept and filters it (see shared/devlog.ts).
//
// Only injected while ReproDesk is armed on an approved target with "Console & network log" switched on.

declare global {
  interface Window {
    __reprodeskPageLog?: boolean;
  }
}

import { PAGELOG_EVENTS } from '../shared/messages';

const { batch: EVT, pull: PULL, ping: PING } = PAGELOG_EVENTS;

if (!window.__reprodeskPageLog) {
  try {
    Object.defineProperty(window, '__reprodeskPageLog', { value: true, enumerable: false });
  } catch {
    /* frozen window: the guard below still holds for this run */
  }
  start();
}

function start(): void {
  // Keep our own references: a page may wrap these later, and our bookkeeping must never go through the page's wrappers.
  const now = Date.now.bind(Date);
  const perf = performance.now.bind(performance);
  const setT = setTimeout.bind(window);
  const stringify = JSON.stringify;
  const dispatch = document.dispatchEvent.bind(document);
  const MAX_QUEUE = 500;
  const queue: unknown[] = [];
  let ready = false;
  let timer = 0;
  let dropped = 0;

  const flush = () => {
    timer = 0;
    if (!ready || (!queue.length && !dropped)) return;
    const batch = queue.splice(0, 100);
    if (dropped) {
      batch.push({ k: 'drop', n: dropped }); // tell the service worker, so the report can say entries are missing
      dropped = 0;
    }
    try {
      dispatch(new CustomEvent(EVT, { detail: stringify(batch) }));
    } catch {
      /* never break the page */
    }
    if (queue.length) timer = setT(flush, 50) as unknown as number;
  };
  const push = (item: unknown) => {
    if (queue.length >= MAX_QUEUE) {
      dropped++; // the content script is not there yet or the page logs in a loop: drop and count, never grow
      return;
    }
    queue.push(item);
    if (ready && queue.length >= 100) flush(); // a burst goes out in batches right away instead of piling up
    else if (!timer) timer = setT(flush, 250) as unknown as number;
  };
  document.addEventListener(PULL, () => {
    ready = true;
    flush();
  });
  dispatch(new CustomEvent(PING));

  // ------------------------------------------------------------ console values -> text (bounded, no DOM text or form values)
  const describeNode = (n: Node): string => {
    if (n instanceof Element) {
      const id = n.id ? `#${n.id}` : '';
      const cls = typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
      return `<${n.tagName.toLowerCase()}${id}${cls}>`;
    }
    return `[${n.nodeName}]`;
  };
  const toText = (v: unknown): unknown => {
    if (typeof v === 'string') return v.length > 4000 ? v.slice(0, 4000) : v;
    if (v === null || typeof v === 'number' || typeof v === 'boolean' || v === undefined) return v === undefined ? 'undefined' : v;
    if (typeof v === 'bigint' || typeof v === 'symbol') return String(v);
    if (typeof v === 'function') return `ƒ ${v.name || 'anonymous'}()`;
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (typeof Node !== 'undefined' && v instanceof Node) return describeNode(v);
    const seen = new WeakSet<object>();
    let budget = 200; // keys visited
    try {
      const out = stringify(v, function (_k, val: unknown) {
        if (--budget < 0) return undefined;
        if (typeof val === 'bigint') return String(val);
        if (typeof val === 'function') return `ƒ ${(val as { name?: string }).name || 'anonymous'}()`;
        if (val instanceof Error) return `${val.name}: ${val.message}`;
        if (typeof Node !== 'undefined' && val instanceof Node) return describeNode(val);
        if (val && typeof val === 'object') {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      });
      return out === undefined ? Object.prototype.toString.call(v) : out.length > 4000 ? out.slice(0, 4000) : out;
    } catch {
      return Object.prototype.toString.call(v);
    }
  };
  const stackOf = (args: unknown[]): string | undefined => {
    for (const a of args) if (a instanceof Error && typeof a.stack === 'string') return a.stack.slice(0, 4000);
    return undefined;
  };
  const record = (level: string, source: string, args: unknown[], stack?: string) => {
    try {
      push({ k: 'c', ts: now(), level, source, args: args.slice(0, 20).map(toText), stack: stack ?? stackOf(args) });
    } catch {
      /* never break the page */
    }
  };

  // ------------------------------------------------------------ console, uncaught errors, unhandled rejections
  const con = console as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const level of ['error', 'warn', 'log', 'info', 'debug', 'trace'] as const) {
    const orig = con[level];
    if (typeof orig !== 'function') continue;
    con[level] = function (this: unknown, ...args: unknown[]) {
      record(level, 'console', args);
      return orig.apply(this, args);
    };
  }
  const origAssert = con.assert;
  if (typeof origAssert === 'function') {
    con.assert = function (this: unknown, cond?: unknown, ...args: unknown[]) {
      if (!cond) record('assert', 'console', ['Assertion failed:', ...args]);
      return origAssert.call(this, cond, ...args);
    };
  }
  addEventListener('error', (e) => {
    if (!(e instanceof ErrorEvent)) return; // a failed <img>/<script> load: the network log has it
    const err = e.error as unknown;
    record('error', 'exception', [err instanceof Error ? err : e.message], err instanceof Error ? err.stack : e.filename ? `    at ${e.filename}:${e.lineno}:${e.colno}` : undefined);
  });
  addEventListener('unhandledrejection', (e) => {
    const r = e.reason as unknown;
    record('error', 'rejection', [r instanceof Error ? r : toText(r)], r instanceof Error ? r.stack : undefined);
  });

  // ------------------------------------------------------------ requests (metadata only)
  const installedAt = perf();
  const abs = (u: string) => {
    try {
      return new URL(u, location.href).href;
    } catch {
      return String(u);
    }
  };
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const ts = now();
      const t0 = perf();
      let method = 'GET';
      let url = '';
      try {
        method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        url = abs(input instanceof Request ? input.url : String(input));
      } catch {
        /* unusual input: still pass it through untouched */
      }
      const p = origFetch.call(this ?? window, input, init);
      p.then(
        (res) => push({ k: 'n', ts, kind: 'fetch', method, url, status: res.status, ms: perf() - t0, size: Number(res.headers.get('content-length')) || undefined }),
        (err: unknown) => push({ k: 'n', ts, kind: 'fetch', method, url, status: 0, ms: perf() - t0, error: (err as { name?: string })?.name === 'AbortError' ? 'aborted' : 'failed' }),
      );
      return p;
    } as typeof fetch;
  }
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      try {
        meta.set(this, { method: String(method).toUpperCase(), url: abs(String(url)) });
      } catch {
        /* ignore */
      }
      return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof XHR.prototype.open;
    XHR.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const m = meta.get(this);
      if (m) {
        // One record per request, with its own listeners, removed when it ends. The status is taken when the response is complete
        // (readyState 4), before the page's own loadend handler could open the same object again for its next request.
        const rec = { ts: now(), t0: perf(), status: 0, size: undefined as number | undefined, error: undefined as string | undefined };
        const ac = new AbortController();
        const on = (type: string, fn: () => void) => this.addEventListener(type, fn, { signal: ac.signal });
        on('readystatechange', () => {
          if (this.readyState !== 4) return;
          rec.status = this.status;
          try {
            rec.size = Number(this.getResponseHeader('content-length')) || undefined;
          } catch {
            /* ignore */
          }
        });
        on('abort', () => (rec.error = 'aborted'));
        on('timeout', () => (rec.error = 'timeout'));
        on('error', () => (rec.error = 'failed'));
        on('loadend', () => {
          ac.abort();
          push({ k: 'n', ts: rec.ts, kind: 'xhr', method: m.method, url: m.url, status: rec.status, ms: perf() - rec.t0, size: rec.size, error: rec.status ? undefined : (rec.error ?? 'failed') });
        });
      }
      return origSend.call(this, body);
    };
  }

  // Everything else the page loads (scripts, styles, images, beacons) and the document itself, from the browser's resource timing.
  // `buffered` also hands over what loaded before this recorder started, so a page load is covered even though we arrive late;
  // fetch / XHR made after we started are left to the wrappers above.
  const timeOrigin = performance.timeOrigin;
  const fromTiming = (e: PerformanceResourceTiming, kind: string) => {
    const status = (e as PerformanceResourceTiming & { responseStatus?: number }).responseStatus ?? 0;
    push({ k: 'n', ts: Math.round(timeOrigin + e.startTime), kind, method: kind === 'document' ? 'GET' : '', url: e.name, status, ms: e.duration, size: e.transferSize || e.encodedBodySize || undefined, initiator: e.initiatorType || undefined });
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) {
        const it = e.initiatorType;
        const viaWrapper = it === 'fetch' || it === 'xmlhttprequest';
        if (viaWrapper && e.startTime >= installedAt) continue;
        fromTiming(e, it === 'fetch' ? 'fetch' : it === 'xmlhttprequest' ? 'xhr' : 'resource');
      }
    }).observe({ type: 'resource', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) fromTiming(e, 'document');
    }).observe({ type: 'navigation', buffered: true });
  } catch {
    /* no PerformanceObserver: the wrappers still work */
  }
}
