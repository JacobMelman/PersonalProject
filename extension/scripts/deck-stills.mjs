// Presentation stills at device scale 2 (sharp on high-density screens): the Northwind Gear scenario in headless Chromium with the
// E2E build, then the shop + side panel while recording, the Review page with the card number masked (redacted preview), the
// screenshot editor, the exported HTML report and the side panel's settings under an organization policy.
//   npm run build:e2e && node scripts/deck-stills.mjs <out dir>
// Headless tab capture keeps the full width of an emulated viewport but only its top part, so mask and editor coordinates are
// normalised against the captured frame, not against the viewport.
import { chromium } from 'playwright';
import { dist, keyInfo, makeHelpers, rmProfile, sleep, tmpProfile } from '../tests/e2e/lib.mjs';
import { startDemoSite } from './demo-site.mjs';
import path from 'node:path';

const out = process.argv[2];
const SITE = 5173;
const site = await startDemoSite(SITE);
const ud = tmpProfile();
const ctx = await chromium.launchPersistentContext(ud, {
  headless: true, channel: 'chromium', acceptDownloads: true, deviceScaleFactor: 2, viewport: { width: 980, height: 760 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, `--allowlisted-extension-id=${keyInfo.id}`, '--no-first-run', '--autoplay-policy=no-user-gesture-required'],
});
if (!ctx.serviceWorkers()[0]) await ctx.waitForEvent('serviceworker');
const { rd, state, dump, until, activeTabId, setSettings } = makeHelpers(() => ctx.serviceWorkers().find((w) => w.url().includes(keyInfo.id)));
const ext = (p) => `chrome-extension://${keyInfo.id}/${p}`;
const shot = async (page, name, opts = {}) => { await page.screenshot({ path: path.join(out, name), ...opts }); console.log('shot', name); };
/** The side panel as its own window, so the tested tab stays the active tab of its window (no Privacy Pause). */
async function panelWindow(w = 400, h = 760) {
  const before = new Set(ctx.pages());
  await rd(async (a) => { await chrome.windows.create({ url: chrome.runtime.getURL('sidepanel.html'), focused: false, width: a.w, height: a.h }); }, { w, h });
  let p = null;
  for (let i = 0; i < 50 && !p; i++) { p = ctx.pages().find((x) => !before.has(x) && x.url().includes('sidepanel.html')); if (!p) await sleep(100); }
  await p.setViewportSize({ width: w, height: h });
  await p.waitForSelector('[data-c]');
  await sleep(900);
  return p;
}

try {
  await setSettings({ replaySec: 90, tailSec: 0, preSessionSec: 30, fps: 15, bitrateKbps: 2500, afkMinutes: 0, openReviewAfterSave: false, markerScreenshot: true, environment: 'QA · staging', highlightClicks: true });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${SITE}/`);
  await page.bringToFront();
  await sleep(500);
  await rd((id) => self.__rd.armTab(id), await activeTabId());
  await until(async () => (await state()).mode === 'armed', 10000);
  await sleep(1500);
  for (const a of ['backpack', 'tent', 'lamp']) { await page.click(`[data-add="${a}"]`); await sleep(600); }
  await page.click('#nav-cart'); await sleep(1000);
  await rd(() => self.__rd.startRepro());
  await sleep(1200);
  await page.click('#promo'); await page.keyboard.type('summer20', { delay: 60 });
  await page.click('#apply'); await sleep(1200);
  await rd(() => self.__rd.marker('Promo discount not applied to total'));
  await sleep(1500);
  await page.click('#checkout-btn'); await sleep(1200);
  const typeIn = async (sel, text) => { await page.click(sel); await page.keyboard.type(text, { delay: 40 }); await sleep(250); };
  await typeIn('#name', 'Alex Morgan'); await typeIn('#email', 'alex@example.com'); await typeIn('#card', '4242424242424242'); await typeIn('#exp', '1228'); await typeIn('#cvv', '123');
  // CSS px; normalised later against the captured frame (headless capture keeps the full width but only the top of an emulated viewport)
  const norm = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x, r.y, r.x + r.width, r.y + r.height]; }, sel);
  const IW = await page.evaluate(() => innerWidth);
  const toFrame = (b, frameH) => [b[0] / IW, b[1] / frameH, b[2] / IW, b[3] / frameH];
  const cardPre = await norm('#card');
  await page.click('#place'); await sleep(2200);
  await rd(() => self.__rd.marker('Order fails with E-4021'));
  await until(async () => (await dump('shots')).length >= 2, 10000);
  await sleep(800);
  const cardPost = await norm('#card'), err = await norm('#error .err');
  console.log('state', JSON.stringify(await state()));

  // ---- capture slide: the shop with the error + the side panel, recording
  await shot(page, 'cap-shop.png');
  const panel = await panelWindow(400, 760);
  console.log('privacy after opening the panel window:', (await state()).privacy);
  await shot(panel, 'cap-panel.png');
  await panel.close();
  await page.bringToFront();

  // ---- finish and review
  await rd(() => self.__rd.finishRepro());
  const sess = await until(async () => (await dump('sessions')).find((s) => s.kind === 'repro' && s.status !== 'active'), 30000);
  const rv = await ctx.newPage();
  await rv.setViewportSize({ width: 1400, height: 800 });
  await rv.goto(ext(`review.html?session=${sess.id}`));
  await until(() => rv.evaluate(() => { const v = document.getElementById('vid'); return v && v.duration > 0; }), 20000);
  // video times of the card number from the timeline (rows seek the player)
  const tt = await rv.evaluate(() => { const v = document.getElementById('vid'); const rows = [...document.querySelectorAll('#tl .tl')];
    const at = (re) => { const r = rows.find((x) => re.test(x.textContent)); if (!r) return null; r.click(); return v.currentTime; };
    return { card: at(/Card number/), place: at(/Place order/), dur: v.duration }; });
  console.log('times', JSON.stringify(tt));
  const vdim = await rv.evaluate(() => { const v = document.getElementById('vid'); return { w: v.videoWidth, h: v.videoHeight }; });
  const frameH = IW * vdim.h / vdim.w;
  console.log('video', JSON.stringify(vdim), 'frame css height', frameH.toFixed(1));
  const pad = 0.012;
  const box = (b, from, to, id) => ({ id, type: 'blur', x1: b[0] - pad / 2, y1: b[1] - pad, x2: b[2] + pad / 2, y2: b[3] + pad, fromMs: Math.round(from * 1000), toMs: Math.round(to * 1000) });
  const edits = { masks: [box(toFrame(cardPre, frameH), Math.max(0, tt.card - 0.3), tt.place + 0.9, 'm1'), box(toFrame(cardPost, frameH), tt.place + 0.2, tt.dur + 1, 'm2')], cuts: [] };
  await rd(async (a) => { const db = await new Promise((res) => { const q = indexedDB.open('reprodesk'); q.onsuccess = () => res(q.result); });
    await new Promise((res) => { const tx = db.transaction('sessions', 'readwrite'); const st = tx.objectStore('sessions'); const g = st.get(a.id); g.onsuccess = () => { st.put({ ...g.result, videoEdits: a.edits }); }; tx.oncomplete = res; }); }, { id: sess.id, edits });
  await rv.reload();
  await until(() => rv.evaluate(() => { const v = document.getElementById('vid'); return v && v.duration > 0; }), 20000);
  await rv.click('#pt-preview');
  for (let i = 0; i < 240; i++) { if (await rv.evaluate(() => !!document.querySelector('#pt-form .badge') && !/Rendering/.test(document.getElementById('ptools')?.textContent ?? ''))) break; await sleep(500); }
  await sleep(1500);
  await rv.evaluate(async (t) => { const v = document.getElementById('vid'); v.pause(); v.currentTime = t; await new Promise((r) => v.addEventListener('seeked', r, { once: true })); }, Math.min(tt.dur - 0.2, tt.place + 3.0));
  await rv.evaluate(() => { document.getElementById('vid').controls = false; });
  await sleep(800);
  await rv.evaluate(() => { const r = document.querySelector('#stage').closest('section').getBoundingClientRect(); window.scrollTo(0, window.scrollY + r.top - 64); });
  await sleep(600);
  await shot(rv, 'review.png');
  await rv.evaluate(() => { document.getElementById('vid').controls = true; });

  // ---- redact slide: the screenshot editor
  await rv.evaluate(() => document.querySelector('.gallery')?.scrollIntoView({ block: 'center' }));
  await sleep(400);
  await rv.click('[data-edit="1"]');
  await sleep(1400);
  const c = await rv.evaluate(() => { const r = document.getElementById('ed-canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const shotH = IW * c.h / c.w;
  const cp = toFrame(cardPost, shotH), er = toFrame(err, shotH);
  const pt = (b, fx, fy) => ({ x: c.x + c.w * fx, y: c.y + c.h * fy });
  const drag = async (a, b) => { await rv.mouse.move(a.x, a.y); await rv.mouse.down(); await rv.mouse.move(b.x, b.y, { steps: 12 }); await rv.mouse.up(); await sleep(300); };
  await rv.click('[data-tool="blur"]');
  await drag(pt(null, cp[0] - pad, cp[1] - pad * 1.4), pt(null, cp[2] + pad, cp[3] + pad * 1.4));
  await rv.click('[data-tool="rect"]');
  await drag(pt(null, er[0] - pad, er[1] - pad), pt(null, er[2] + pad, er[3] + pad));
  await rv.mouse.move(5, 400);
  await sleep(600);
  await shot(rv, 'editor.png');
  await rv.click('#ed-save');
  await sleep(1500);

  // ---- export slide: the exported HTML report
  await rv.fill('#f-actual', 'Promo SUMMER20 shows a discount but the total is unchanged; Place order fails with E-4021.');
  await rv.fill('#f-exp', 'The total includes the discount and the order is placed.');
  await rv.locator('#f-exp').blur();
  await rv.evaluate(() => document.querySelectorAll('[data-fmt]').forEach((x) => (x.checked = x.dataset.fmt === 'html')));
  const dl = [];
  rv.on('download', (d) => dl.push(d));
  await rv.click('#export');
  await until(async () => dl.length >= 1, 90000);
  const html = path.join(out, 'report.html');
  await dl[0].saveAs(html);
  const rp = await ctx.newPage();
  await rp.setViewportSize({ width: 1400, height: 800 });
  await rp.goto('file://' + html);
  await sleep(1200);
  await shot(rp, 'export.png');
  await rp.evaluate(() => window.scrollTo(0, 560));
  await sleep(500);
  await shot(rp, 'export-2.png');

  // ---- admin slide: settings managed by an organization
  await rd(async () => chrome.storage.local.set({ __policy: { BlockedOrigins: ['https://*.bank.example'], ReplayWindowSec: 60, PostTriggerTailSec: 5, PreSessionContextSec: 30, AfkAutoPauseMinutes: 10, EnvironmentLabel: 'QA · staging', AllowedExportFormats: ['zip', 'html', 'docx'], AllowUnredactedOriginals: false } }));
  await sleep(600);
  const ap = await panelWindow(420, 980);
  await ap.click('[data-nav="settings"]').catch(() => undefined);
  await sleep(1200);
  await shot(ap, 'admin.png');
} catch (e) {
  console.error('deck stills aborted:', e instanceof Error ? e.stack : e);
  process.exitCode = 1;
} finally {
  await ctx.close().catch(() => undefined);
  site.close();
  rmProfile(ud);
}
