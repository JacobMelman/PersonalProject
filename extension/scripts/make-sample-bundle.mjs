// Records the Northwind Gear demo scenario ONCE with the real extension (real headed Chromium under Xvfb, genuine toolbar click, real
// typing) and stores it as the bundled "sample sessions" (public/sample/*). Run: npm run demo:bundle. The result is committed;
// the extension never records anything by itself.
//   - one Instant Replay session (browsing, items added to the cart)
//   - one Repro Session (promo code ignored by the total, order fails with E-4021) with markers + screenshots
// Typed values (including the card number) show up in the pixels on purpose: this is exactly what the redaction tools are for.
import { startDisplay, launchChrome, tmpProfile, rmProfile, sleep, xdo, findPage, realClick, clickToolbarIcon, keyInfo } from '../tests/real/lib.mjs';
import { makeProbe } from '../tests/real/probe.mjs';
import { startDemoSite } from './demo-site.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const proj = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(proj, 'public', 'sample');
const PORT = Number(process.env.RD_PORT ?? 9333), SITE = Number(process.env.RD_SITE ?? 5173);
const FAKE_ORIGIN = 'https://staging.northwind-gear.example';
const site = await startDemoSite(SITE);
const disp = await startDisplay('1600x1000x24');
const userData = tmpProfile();
const chrome = await launchChrome({ userData, port: PORT, startUrl: `http://localhost:${SITE}/`, width: 1280, height: 800 });
const type = async (page, sel, text) => { await realClick(page, sel); xdo('type', '--delay', '60', text); await sleep(300); };

try {
  await sleep(3500);
  const probe = await makeProbe(PORT);
  await probe.setSettings({ replaySec: 30, tailSec: 3, preSessionSec: 0, fps: 10, bitrateKbps: 600, afkMinutes: 0, openReviewAfterSave: false, environment: 'QA · staging', markerScreenshot: true });
  const page = await findPage(PORT, `http://localhost:${SITE}/`);
  await clickToolbarIcon();
  await probe.until(async () => (await probe.state())?.mode === 'armed', 10000);
  const panel = await findPage(PORT, 'chrome-extension://' + keyInfo.id + '/sidepanel.html');
  const click = (c) => panel.eval(`document.querySelector('[data-c="${c}"]').click()`);
  const label = (t) => panel.eval(`(() => { const i = document.getElementById('markerLabel'); i.focus(); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(1800);

  // ---- Instant Replay: "I just saw something odd"
  await realClick(page, '[data-add="backpack"]'); await sleep(900);
  await realClick(page, '[data-add="tent"]'); await sleep(900);
  await realClick(page, '[data-add="lamp"]'); await sleep(8500);
  await click('saveReplay'); await sleep(5500);
  const instant = await probe.until(async () => (await probe.dump('sessions')).find((s) => s.kind === 'instant' && s.status === 'finished'), 20000);
  if (!instant) throw new Error('instant replay did not finish');

  // ---- Repro Session
  await realClick(page, '#nav-cart'); await sleep(1200);
  await click('startRepro'); await sleep(2200);
  await type(page, '#promo', 'summer20'); await realClick(page, '#apply'); await sleep(1800);
  await label('Promo discount not applied to total'); await sleep(500); await click('marker'); await sleep(2600);
  await realClick(page, '#checkout-btn'); await sleep(1500);
  await type(page, '#name', 'Alex Morgan'); await type(page, '#email', 'alex@example.com'); await type(page, '#card', '4242424242424242'); await type(page, '#exp', '1228'); await type(page, '#cvv', '123');
  await realClick(page, '#place'); await sleep(2600);
  await label('Order fails with E-4021'); await sleep(500); await click('marker'); await sleep(2800);
  await click('finishRepro'); await sleep(3000);
  const repro = await probe.until(async () => (await probe.dump('sessions')).find((s) => s.kind === 'repro' && s.status === 'finished'), 20000);
  if (!repro) throw new Error('repro session did not finish');
  await sleep(1000);

  // ---- export everything that belongs to the two sessions
  const ids = new Set([instant.id, repro.id]);
  const dump = probe.dump;
  const sessions = (await dump('sessions')).filter((s) => ids.has(s.id));
  const events = (await dump('events')).filter((e) => ids.has(e.sessionId));
  const shots = (await dump('shots')).filter((s) => ids.has(s.sessionId));
  const segments = (await dump('segments')).filter((s) => s.refs.some((r) => ids.has(r)));
  const readOpfs = (file) => probe.p.eval(`(async () => {
    const parts = ${JSON.stringify(file)}.split('/'); let d = await navigator.storage.getDirectory();
    for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x);
    const buf = new Uint8Array(await (await (await d.getFileHandle(parts.at(-1))).getFile()).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  })()`);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  let totalBytes = 0;
  const put = (name, b64) => { const b = Buffer.from(b64, 'base64'); totalBytes += b.length; writeFileSync(path.join(outDir, name), b); return b.length; };
  const scrub = (v) => (typeof v === 'string' ? v.split(`http://localhost:${SITE}`).join(FAKE_ORIGIN) : v);
  const segOut = [];
  for (const [i, s] of segments.entries()) {
    const file = `seg-${String(i).padStart(3, '0')}.bin`;
    put(file, await readOpfs(`seg/${s.id}.bin`));
    segOut.push({ ...s, file });
  }
  const shotOut = [];
  for (const [i, s] of shots.sort((a, b) => a.ts - b.ts).entries()) {
    const file = `shot-${i}.png`;
    put(file, await readOpfs(s.file));
    shotOut.push({ ...s, file, origin: scrub(s.origin), annotations: [] });
  }
  const reproReport = {
    title: '[Sample] Promo code SUMMER20 is not applied to the order total; Place order fails with E-4021',
    severity: 'Major',
    actual: 'The cart shows a promo line and the message "20% discount applied", but the Total stays unchanged. On Checkout, "Place order" ends with "Something went wrong ... (E-4021)" and no order is created.',
    expected: 'The Total reflects the 20% discount, and "Place order" creates the order and shows a confirmation.',
    notes: 'Sample session generated from a scripted run of the Northwind Gear demo shop. Not real evidence.',
  };
  const bundle = {
    version: 1,
    generatedWith: 'scripts/make-sample-bundle.mjs',
    anchor: Math.max(...sessions.map((s) => s.endedAt ?? 0), ...segments.map((s) => s.endWall)),
    sessions: sessions.map((s) => ({ ...s, sample: true, targetOrigin: FAKE_ORIGIN, environment: 'QA · staging', reviewedAt: undefined })),
    events: events.map(({ id: _id, tabId: _t, ...e }) => ({ ...e, origin: e.origin ? FAKE_ORIGIN : e.origin })),
    shots: shotOut,
    reports: [{ ...reproReport, sessionKey: repro.id }],
    segments: segOut,
    reproId: repro.id,
    instantId: instant.id,
  };
  writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(bundle));
  totalBytes += JSON.stringify(bundle).length;
  console.log(`sample bundle: ${sessions.length} sessions, ${events.length} events, ${shotOut.length} screenshots, ${segOut.length} segments, ${(totalBytes / 1048576).toFixed(2)} MB -> public/sample/`);
} finally {
  await chrome.close(); disp.stop(); site.close(); rmProfile(userData);
}
