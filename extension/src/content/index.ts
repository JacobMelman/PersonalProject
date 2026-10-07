// Target-page semantic collector. Records mouse/focus/submit/navigation semantics only.
// It never reads: key events, clipboard, input/textarea/select/contenteditable values or text of editable controls.
import { PORT_NAME, type ContentMessage } from '../shared/messages';
import { implicitRole, isEditableKind, minimizeUrl, sanitizeLabel, sanitizeStableId } from '../shared/privacy';
import type { ElementDescriptor } from '../shared/types';

declare global {
  interface Window {
    __reprodeskContent?: boolean;
  }
}

if (!window.__reprodeskContent && window.top === window) {
  window.__reprodeskContent = true;
  start();
}

function start(): void {
  let port: chrome.runtime.Port | null = null;

  const here = () => minimizeUrl(location.href);
  const send = (m: ContentMessage) => {
    try {
      port?.postMessage(m);
    } catch {
      connect();
    }
  };
  const hello = () => {
    const u = here();
    if (u) send({ t: 'hello', origin: u.origin, path: u.path, visible: document.visibilityState === 'visible' });
  };

  function connect(): void {
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
      port.onDisconnect.addListener(() => {
        port = null;
        // The service worker may have been recycled while the page is still alive: reconnect.
        setTimeout(() => {
          if (!port && chrome.runtime?.id) {
            connect();
          }
        }, 500);
      });
      hello();
    } catch {
      port = null; // extension reloaded: this orphaned script just goes quiet
    }
  }

  function structuralPath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let i = 0; cur && cur !== document.documentElement && i < 5; i++) {
      const parent: Element | null = cur.parentElement;
      const tag = cur.tagName.toLowerCase();
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        parts.unshift(same.length > 1 ? `${tag}:nth(${same.indexOf(cur) + 1})` : tag);
      } else parts.unshift(tag);
      cur = parent;
    }
    return parts.join('>');
  }

  function describe(target: EventTarget | null): ElementDescriptor | null {
    let el = target instanceof Element ? target : null;
    if (!el) return null;
    // Prefer the nearest interactive ancestor so "click on <span> inside <button>" reports the button.
    const interactive = el.closest('a,button,input,select,textarea,summary,[role],label,[onclick],[tabindex]');
    if (interactive) el = interactive;
    const tag = el.tagName.toLowerCase();
    const type = el instanceof HTMLInputElement ? el.type || 'text' : el.getAttribute('type');
    const editable = isEditableKind(tag, type, (el as HTMLElement).isContentEditable === true);
    const aria = el.getAttribute('aria-label');
    let labelSource: string | null | undefined = aria;
    if (!labelSource) {
      if (editable) {
        // Associated <label> text is static UI copy, never the control's content.
        const id = el.getAttribute('id');
        const lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest('label');
        labelSource = lab?.textContent ?? el.getAttribute('placeholder');
      } else {
        labelSource = (el as HTMLElement).innerText ?? el.textContent;
      }
    }
    const state: string[] = [];
    if ((el as HTMLButtonElement).disabled) state.push('disabled');
    if (el.getAttribute('aria-expanded') === 'true') state.push('expanded');
    if (el instanceof HTMLInputElement && (type === 'checkbox' || type === 'radio') && el.checked) state.push('checked');
    return {
      tag,
      role: el.getAttribute('role') ?? implicitRole(tag, type),
      type: type ?? null,
      label: sanitizeLabel(labelSource),
      stableId: sanitizeStableId(el.getAttribute('data-testid') ?? el.getAttribute('id')),
      fingerprint: structuralPath(el),
      state,
    };
  }

  const emit = (ev: Extract<ContentMessage, { t: 'event' }>['ev']) => {
    if (document.visibilityState !== 'visible') return;
    send({ t: 'event', ev: { ...ev, ts: Date.now() } });
  };
  const loc = () => here() ?? { origin: location.origin, path: '/' };

  addEventListener(
    'click',
    (e) => {
      const el = describe(e.target);
      if (!el) return;
      const u = loc();
      emit({
        type: 'click',
        origin: u.origin,
        path: u.path,
        element: el,
        pos: { x: +(e.clientX / Math.max(innerWidth, 1)).toFixed(3), y: +(e.clientY / Math.max(innerHeight, 1)).toFixed(3) },
        source: 'chromium:dom',
        confidence: 0.97,
      });
    },
    true,
  );
  addEventListener(
    'focusin',
    (e) => {
      const el = describe(e.target);
      if (!el) return;
      const u = loc();
      emit({ type: 'focus', origin: u.origin, path: u.path, element: el, source: 'chromium:dom', confidence: 0.9 });
    },
    true,
  );
  addEventListener(
    'submit',
    (e) => {
      const el = describe(e.target);
      const u = loc();
      emit({ type: 'submit', origin: u.origin, path: u.path, element: el ?? undefined, source: 'chromium:dom', confidence: 0.9 });
    },
    true,
  );

  // SPA navigation: Navigation API when available, otherwise popstate/hashchange plus a light URL watcher.
  let lastKey = '';
  const checkNav = () => {
    const u = here();
    if (!u) return;
    const key = u.origin + u.path;
    if (key === lastKey) return;
    const first = lastKey === '';
    lastKey = key;
    if (!first) emit({ type: 'navigate', origin: u.origin, path: u.path, source: 'chromium:nav', confidence: 1 });
    hello();
  };
  checkNav();
  addEventListener('popstate', checkNav);
  addEventListener('hashchange', checkNav);
  (window as unknown as { navigation?: EventTarget }).navigation?.addEventListener('navigatesuccess', checkNav);
  setInterval(checkNav, 750);
  document.addEventListener('visibilitychange', hello);

  connect();
}
