import { openBackgroundPage, keyInfo } from './lib.mjs';
/** Extension-page probe (background tab) used to read state, settings and IndexedDB without attaching a debugger to the service worker. */
export async function makeProbe(port) {
  const p = await openBackgroundPage(port, `chrome-extension://${keyInfo.id}/review.html`);
  const idb = (store) => p.eval(`new Promise((res, rej) => { const q = indexedDB.open('reprodesk'); q.onsuccess = () => { const t = q.result.transaction('${store}').objectStore('${store}').getAll(); t.onsuccess = () => res(t.result); }; q.onerror = () => rej(q.error); })`);
  return {
    p,
    state: () => p.eval(`chrome.storage.session.get('state').then((r) => r.state ?? null)`),
    session: (k) => p.eval(`chrome.storage.session.get(${JSON.stringify(k)}).then((r) => r[${JSON.stringify(k)}] ?? null)`),
    setSettings: (patch) => p.eval(`chrome.storage.local.get('settings').then((r) => chrome.storage.local.set({ settings: { ...(r.settings ?? {}), ...${JSON.stringify(patch)} } }))`),
    dump: idb,
    health: async () => (await idb('journal')).find((j) => j.key === 'health') ?? null,
    badge: () => p.eval(`chrome.action.getBadgeText({})`),
    commands: () => p.eval(`chrome.commands.getAll()`),
    until: async (fn, ms = 15000, step = 300) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, step)); } },
  };
}
