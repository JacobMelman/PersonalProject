"use strict";
(() => {
  // src/shared/messages.ts
  var PORT_NAME = "rd-content", FRAME_PORT_NAME = "rd-frame";

  // src/shared/privacy.ts
  var REDACTED = "[redacted]", EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, JWT = /eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, DIGITS = /\d[\d\s().-]{5,}\d/g, LONG_TOKEN = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g;
  function sanitizeLabel(text, max = 80) {
    if (!text) return null;
    let t = text.replace(/\s+/g, " ").trim();
    return t ? (t = t.replace(JWT, REDACTED).replace(EMAIL, REDACTED).replace(LONG_TOKEN, REDACTED).replace(DIGITS, REDACTED), t.length > max && (t = t.slice(0, max - 1).trimEnd() + "\u2026"), t) : null;
  }
  function sanitizeStableId(id) {
    return !id || !/^[A-Za-z][\w:.-]{0,48}$/.test(id) || /[0-9a-f]{12,}/i.test(id.replace(/[-_]/g, "")) || (id.match(/\d/g) ?? []).length >= 6 ? null : id;
  }
  function minimizeUrl(href) {
    if (!href) return null;
    let u;
    try {
      u = new URL(href);
    } catch {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    let path = u.pathname.split("/").map((seg) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ? ":id" : seg.length >= 24 && /\d/.test(seg) && /[A-Za-z]/.test(seg) ? ":token" : seg).join("/");
    return { origin: u.origin, path: path || "/" };
  }
  var IMPLICIT_ROLES = {
    a: "link",
    button: "button",
    select: "combobox",
    textarea: "textbox",
    img: "img",
    nav: "navigation",
    table: "table",
    dialog: "dialog",
    summary: "button"
  };
  function implicitRole(tag, type) {
    if (tag === "input")
      switch (type) {
        case "checkbox":
          return "checkbox";
        case "radio":
          return "radio";
        case "button":
        case "submit":
        case "reset":
        case "image":
          return "button";
        case "range":
          return "slider";
        case "search":
          return "searchbox";
        default:
          return "textbox";
      }
    return IMPLICIT_ROLES[tag] ?? null;
  }
  function isEditableKind(tag, type, contentEditable) {
    return contentEditable || tag === "textarea" || tag === "select" ? !0 : tag === "input" ? !["button", "submit", "reset", "image", "checkbox", "radio"].includes(type ?? "text") : !1;
  }

  // src/content/index.ts
  window.__reprodeskContent || (window.__reprodeskContent = !0, start(window.top === window));
  function start(isTop) {
    let port = null, here = () => minimizeUrl(location.href), send = (m) => {
      try {
        port?.postMessage(m);
      } catch {
        connect();
      }
    }, hello = () => {
      if (!isTop) return;
      let u = here();
      u && send({ t: "hello", origin: u.origin, path: u.path, visible: document.visibilityState === "visible" });
    };
    function connect() {
      try {
        port = chrome.runtime.connect({ name: isTop ? PORT_NAME : FRAME_PORT_NAME }), port.onDisconnect.addListener(() => {
          port = null, setTimeout(() => {
            !port && chrome.runtime?.id && connect();
          }, 500);
        }), hello();
      } catch {
        port = null;
      }
    }
    function structuralPath(el) {
      let parts = [], cur = el;
      for (let i = 0; cur && cur !== document.documentElement && i < 5; i++) {
        let parent = cur.parentElement, tag = cur.tagName.toLowerCase();
        if (parent) {
          let same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
          parts.unshift(same.length > 1 ? `${tag}:nth(${same.indexOf(cur) + 1})` : tag);
        } else parts.unshift(tag);
        cur = parent;
      }
      return parts.join(">");
    }
    let NAMED_ROLES = /* @__PURE__ */ new Set(["button", "link", "menuitem", "tab", "option", "row", "cell", "gridcell", "checkbox", "radio", "switch", "treeitem", "columnheader"]);
    function labelAllowed(el) {
      let tag = el.tagName.toLowerCase();
      if (["a", "button", "summary", "label", "option", "th", "td", "li", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) return !0;
      let role = el.getAttribute("role");
      return role && NAMED_ROLES.has(role) ? !0 : el.children.length === 0;
    }
    function describe(target) {
      let el = target instanceof Element ? target : null;
      if (!el) return null;
      let interactive = el.closest("a,button,input,select,textarea,summary,[role],label,[onclick],[tabindex]");
      interactive && (el = interactive);
      let tag = el.tagName.toLowerCase(), type = el instanceof HTMLInputElement ? el.type || "text" : el.getAttribute("type"), editable = isEditableKind(tag, type, el.isContentEditable === !0), labelSource = el.getAttribute("aria-label");
      if (!labelSource)
        if (editable) {
          let id = el.getAttribute("id");
          labelSource = (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest("label"))?.textContent ?? el.getAttribute("placeholder");
        } else labelAllowed(el) && (labelSource = el.innerText ?? el.textContent);
      let state = [];
      return el.disabled && state.push("disabled"), el.getAttribute("aria-expanded") === "true" && state.push("expanded"), el instanceof HTMLInputElement && (type === "checkbox" || type === "radio") && el.checked && state.push("checked"), {
        tag,
        role: el.getAttribute("role") ?? implicitRole(tag, type),
        type: type ?? null,
        label: sanitizeLabel(labelSource),
        stableId: sanitizeStableId(el.getAttribute("data-testid") ?? el.getAttribute("id")),
        fingerprint: structuralPath(el),
        state
      };
    }
    let emit = (ev) => {
      document.visibilityState === "visible" && send({ t: "event", ev: { ...ev, ts: Date.now(), frame: !isTop || void 0 } });
    }, loc = () => here() ?? { origin: location.origin, path: "/" };
    addEventListener(
      "click",
      (e) => {
        let el = describe(e.composedPath()[0] ?? e.target);
        if (!el) return;
        let u = loc();
        emit({
          type: "click",
          origin: u.origin,
          path: u.path,
          element: el,
          pos: { x: +(e.clientX / Math.max(innerWidth, 1)).toFixed(3), y: +(e.clientY / Math.max(innerHeight, 1)).toFixed(3) },
          source: "chromium:dom",
          confidence: 0.97
        });
      },
      !0
    ), addEventListener(
      "focusin",
      (e) => {
        let el = describe(e.composedPath()[0] ?? e.target);
        if (!el) return;
        let u = loc();
        emit({ type: "focus", origin: u.origin, path: u.path, element: el, source: "chromium:dom", confidence: 0.9 });
      },
      !0
    ), addEventListener(
      "submit",
      (e) => {
        let el = describe(e.target), u = loc();
        emit({ type: "submit", origin: u.origin, path: u.path, element: el ?? void 0, source: "chromium:dom", confidence: 0.9 });
      },
      !0
    );
    let lastKey = "", checkNav = () => {
      let u = here();
      if (!u) return;
      let key = u.origin + u.path;
      if (key === lastKey) return;
      let first = lastKey === "";
      lastKey = key, first || emit({ type: "navigate", origin: u.origin, path: u.path, source: "chromium:nav", confidence: 1 }), hello();
    };
    isTop && checkNav(), addEventListener("popstate", checkNav), addEventListener("hashchange", checkNav), window.navigation?.addEventListener("navigatesuccess", checkNav), isTop && setInterval(checkNav, 750), document.addEventListener("visibilitychange", hello), isTop && (setInterval(() => {
      document.visibilityState === "visible" && send({ t: "ping" });
    }, 1e3), addEventListener("pagehide", () => send({ t: "bye" })), addEventListener("pageshow", hello)), connect();
  }
})();
