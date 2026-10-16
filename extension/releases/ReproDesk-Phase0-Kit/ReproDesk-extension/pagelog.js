"use strict";
(() => {
  // src/shared/messages.ts
  var PAGELOG_EVENTS = { batch: "__reprodesk_log", pull: "__reprodesk_log_pull", ping: "__reprodesk_log_ping" };

  // src/pagelog/index.ts
  var { batch: EVT, pull: PULL, ping: PING } = PAGELOG_EVENTS;
  if (!window.__reprodeskPageLog) {
    try {
      Object.defineProperty(window, "__reprodeskPageLog", { value: !0, enumerable: !1 });
    } catch {
    }
    start();
  }
  function start() {
    let now = Date.now.bind(Date), perf = performance.now.bind(performance), setT = setTimeout.bind(window), stringify = JSON.stringify, dispatch = document.dispatchEvent.bind(document), MAX_QUEUE = 500, queue = [], ready = !1, timer = 0, dropped = 0, flush = () => {
      if (timer = 0, !ready || !queue.length && !dropped) return;
      let batch = queue.splice(0, 100);
      dropped && (batch.push({ k: "drop", n: dropped }), dropped = 0);
      try {
        dispatch(new CustomEvent(EVT, { detail: stringify(batch) }));
      } catch {
      }
      queue.length && (timer = setT(flush, 50));
    }, push = (item) => {
      if (queue.length >= MAX_QUEUE) {
        dropped++;
        return;
      }
      queue.push(item), ready && queue.length >= 100 ? flush() : timer || (timer = setT(flush, 250));
    };
    document.addEventListener(PULL, () => {
      ready = !0, flush();
    }), dispatch(new CustomEvent(PING));
    let describeNode = (n) => {
      if (n instanceof Element) {
        let id = n.id ? `#${n.id}` : "", cls = typeof n.className == "string" && n.className.trim() ? "." + n.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
        return `<${n.tagName.toLowerCase()}${id}${cls}>`;
      }
      return `[${n.nodeName}]`;
    }, toText = (v) => {
      if (typeof v == "string") return v.length > 4e3 ? v.slice(0, 4e3) : v;
      if (v === null || typeof v == "number" || typeof v == "boolean" || v === void 0) return v === void 0 ? "undefined" : v;
      if (typeof v == "bigint" || typeof v == "symbol") return String(v);
      if (typeof v == "function") return `\u0192 ${v.name || "anonymous"}()`;
      if (v instanceof Error) return `${v.name}: ${v.message}`;
      if (typeof Node < "u" && v instanceof Node) return describeNode(v);
      let seen = /* @__PURE__ */ new WeakSet(), budget = 200;
      try {
        let out = stringify(v, function(_k, val) {
          if (!(--budget < 0)) {
            if (typeof val == "bigint") return String(val);
            if (typeof val == "function") return `\u0192 ${val.name || "anonymous"}()`;
            if (val instanceof Error) return `${val.name}: ${val.message}`;
            if (typeof Node < "u" && val instanceof Node) return describeNode(val);
            if (val && typeof val == "object") {
              if (seen.has(val)) return "[Circular]";
              seen.add(val);
            }
            return val;
          }
        });
        return out === void 0 ? Object.prototype.toString.call(v) : out.length > 4e3 ? out.slice(0, 4e3) : out;
      } catch {
        return Object.prototype.toString.call(v);
      }
    }, stackOf = (args) => {
      for (let a of args) if (a instanceof Error && typeof a.stack == "string") return a.stack.slice(0, 4e3);
    }, record = (level, source, args, stack) => {
      try {
        push({ k: "c", ts: now(), level, source, args: args.slice(0, 20).map(toText), stack: stack ?? stackOf(args) });
      } catch {
      }
    }, con = console;
    for (let level of ["error", "warn", "log", "info", "debug", "trace"]) {
      let orig = con[level];
      typeof orig == "function" && (con[level] = function(...args) {
        return record(level, "console", args), orig.apply(this, args);
      });
    }
    let origAssert = con.assert;
    typeof origAssert == "function" && (con.assert = function(cond, ...args) {
      return cond || record("assert", "console", ["Assertion failed:", ...args]), origAssert.call(this, cond, ...args);
    }), addEventListener("error", (e) => {
      if (!(e instanceof ErrorEvent)) return;
      let err = e.error;
      record("error", "exception", [err instanceof Error ? err : e.message], err instanceof Error ? err.stack : e.filename ? `    at ${e.filename}:${e.lineno}:${e.colno}` : void 0);
    }), addEventListener("unhandledrejection", (e) => {
      let r = e.reason;
      record("error", "rejection", [r instanceof Error ? r : toText(r)], r instanceof Error ? r.stack : void 0);
    });
    let installedAt = perf(), abs = (u) => {
      try {
        return new URL(u, location.href).href;
      } catch {
        return String(u);
      }
    }, origFetch = window.fetch;
    typeof origFetch == "function" && (window.fetch = function(input, init) {
      let ts = now(), t0 = perf(), method = "GET", url = "";
      try {
        method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(), url = abs(input instanceof Request ? input.url : String(input));
      } catch {
      }
      let p = origFetch.call(this ?? window, input, init);
      return p.then(
        (res) => push({ k: "n", ts, kind: "fetch", method, url, status: res.status, ms: perf() - t0, size: Number(res.headers.get("content-length")) || void 0 }),
        (err) => push({ k: "n", ts, kind: "fetch", method, url, status: 0, ms: perf() - t0, error: err?.name === "AbortError" ? "aborted" : "failed" })
      ), p;
    });
    let XHR = window.XMLHttpRequest;
    if (XHR) {
      let meta = /* @__PURE__ */ new WeakMap(), origOpen = XHR.prototype.open, origSend = XHR.prototype.send;
      XHR.prototype.open = function(method, url, ...rest) {
        try {
          meta.set(this, { method: String(method).toUpperCase(), url: abs(String(url)) });
        } catch {
        }
        return origOpen.call(this, method, url, ...rest);
      }, XHR.prototype.send = function(body) {
        let m = meta.get(this);
        if (m) {
          let rec = { ts: now(), t0: perf(), status: 0, size: void 0, error: void 0 }, ac = new AbortController(), on = (type, fn) => this.addEventListener(type, fn, { signal: ac.signal });
          on("readystatechange", () => {
            if (this.readyState === 4) {
              rec.status = this.status;
              try {
                rec.size = Number(this.getResponseHeader("content-length")) || void 0;
              } catch {
              }
            }
          }), on("abort", () => rec.error = "aborted"), on("timeout", () => rec.error = "timeout"), on("error", () => rec.error = "failed"), on("loadend", () => {
            ac.abort(), push({ k: "n", ts: rec.ts, kind: "xhr", method: m.method, url: m.url, status: rec.status, ms: perf() - rec.t0, size: rec.size, error: rec.status ? void 0 : rec.error ?? "failed" });
          });
        }
        return origSend.call(this, body);
      };
    }
    let timeOrigin = performance.timeOrigin, fromTiming = (e, kind) => {
      let status = e.responseStatus ?? 0;
      push({ k: "n", ts: Math.round(timeOrigin + e.startTime), kind, method: kind === "document" ? "GET" : "", url: e.name, status, ms: e.duration, size: e.transferSize || e.encodedBodySize || void 0, initiator: e.initiatorType || void 0 });
    };
    try {
      new PerformanceObserver((list) => {
        for (let e of list.getEntries()) {
          let it = e.initiatorType;
          (it === "fetch" || it === "xmlhttprequest") && e.startTime >= installedAt || fromTiming(e, it === "fetch" ? "fetch" : it === "xmlhttprequest" ? "xhr" : "resource");
        }
      }).observe({ type: "resource", buffered: !0 }), new PerformanceObserver((list) => {
        for (let e of list.getEntries()) fromTiming(e, "document");
      }).observe({ type: "navigation", buffered: !0 });
    } catch {
    }
  }
})();
