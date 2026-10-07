// Shared helpers for the Playwright e2e scripts.
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.dirname(fileURLToPath(import.meta.url));
export const dist = path.resolve(root, '../../dist');
export const keyInfo = JSON.parse(readFileSync(path.resolve(root, '../../manifest.key.json'), 'utf8'));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startSite(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = url.pathname === '/popup.html' ? 'popup.html' : 'index.html'; // SPA fallback
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(readFileSync(path.join(root, 'site', file)));
  });
  await new Promise((r) => server.listen(port, r));
  return server;
}

export function newReporter() {
  const results = [];
  let failed = 0;
  const ok = (name, cond, extra = '') => {
    results.push({ name, ok: !!cond });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  - ' + extra : ''}`);
    if (!cond) failed++;
  };
  const summary = () => {
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed${failed ? `, ${failed} failure(s)` : ''}`);
    return failed;
  };
  const fail = () => { failed++; };
  return { ok, summary, fail };
}

export function tmpProfile() {
  return mkdtempSync(path.join(tmpdir(), 'rd-e2e-'));
}
export function rmProfile(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export async function launch(userData) {
  const ctx = await chromium.launchPersistentContext(userData, {
    headless: process.env.HEADED !== '1',
    channel: 'chromium',
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, `--allowlisted-extension-id=${keyInfo.id}`, '--no-first-run', '--autoplay-policy=no-user-gesture-required'],
    viewport: { width: 1000, height: 700 },
    acceptDownloads: true,
  });
  if (!ctx.serviceWorkers()[0]) await ctx.waitForEvent('serviceworker');
  const h = makeHelpers(() => ctx.serviceWorkers().find((w) => w.url().includes(keyInfo.id)));
  return { ctx, ...h };
}

export function makeHelpers(getSw) {
  const rd = async (fn, arg) => {
    for (let i = 0; i < 40; i++) {
      const w = getSw();
      if (w) {
        try {
          return await w.evaluate(fn, arg);
        } catch (e) {
          if (!/closed|destroyed|terminated|detached|Target/i.test(String(e))) throw e; // the worker was recycled mid-call: retry on the new one
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('service worker unavailable');
  };
  const idbOpen = `new Promise((res, rej) => { const q = indexedDB.open('reprodesk'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); })`;
  return {
    rd,
    state: () => rd(() => self.__rd.state()),
    setSettings: (patch) => rd(async (p) => { const r = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...(r.settings ?? {}), ...p } }); }, patch),
    health: () => rd(async () => { const db = await new Promise((res, rej) => { const q = indexedDB.open('reprodesk'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); return new Promise((res) => { const q = db.transaction('journal').objectStore('journal').get('health'); q.onsuccess = () => res(q.result ?? null); }); }),
    dump: (store) => rd(async (s) => { const db = await new Promise((res, rej) => { const q = indexedDB.open('reprodesk'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); return new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); }); }, store),
    activeTabId: () => rd(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? null),
    until: async (fn, ms = 15000, step = 250) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } },
    _unused: idbOpen,
  };
}
