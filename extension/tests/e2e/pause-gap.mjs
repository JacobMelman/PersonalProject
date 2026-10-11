// Privacy Pause inside a replay (reported by a tester): arm on the shop, switch to another tab for a while, come back, save.
// The video must contain no frame from the time the tab was in the background, and the pause must not stretch it: before the
// fix a 20 s pause showed up as the last frame frozen for 20 s. Now each pause is a short "not recorded" card.
// Covered: Instant Replay, the redacted copy (cut + preview) and a Repro Session (demo step 8).
import { keyInfo, launch, newReporter, rmProfile, sleep, startSite, tmpProfile } from './lib.mjs';
import { mkdtempSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PORT = 4184;
const server = await startSite(PORT);
const rep = newReporter();
const ok = rep.ok;
const userData = tmpProfile();
const { ctx, rd, setSettings, dump, until, activeTabId, state } = await launch(userData);
const out = mkdtempSync(path.join(tmpdir(), 'rd-gap-'));
const RED = 'rgb(220, 30, 30)', GREEN = 'rgb(20, 170, 40)', BLUE = 'rgb(30, 60, 220)';

// Paint the whole page one colour plus a ticking counter, so the capture keeps producing frames of a known colour.
const paint = (page, color) => page.evaluate((c) => {
  let el = document.getElementById('__tick');
  if (!el) {
    el = document.createElement('div');
    el.id = '__tick';
    el.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;font:700 120px sans-serif;color:#fff';
    document.body.appendChild(el);
    setInterval(() => (el.textContent = String(Date.now() % 100000)), 100);
  }
  el.style.background = c;
}, color);

const hueOf = (png) => {
  const [r, g, b] = execFileSync('convert', [png, '-crop', '40x40+4+4', '+repage', '-scale', '1x1!', '-format', '%[fx:int(255*r)] %[fx:int(255*g)] %[fx:int(255*b)]', 'info:']).toString().trim().split(' ').map(Number);
  if (r > 150 && g < 90 && b < 90) return 'red';
  if (g > 120 && r < 90 && b < 90) return 'green';
  if (b > 150 && r < 90 && g < 120) return 'blue';
  if (r < 30 && g < 45 && b >= 30 && b < 70) return 'card'; // the dark navy "not recorded" card (#0E1A2B)
  if (r < 20 && g < 20 && b < 20) return 'black';
  return `other(${r},${g},${b})`;
};

// The video the Review page is playing right now (original or redacted preview), analysed at 4 frames a second.
let n = 0;
async function playing(rv) {
  const b64 = await rv.evaluate(async () => {
    const buf = new Uint8Array(await (await fetch(document.getElementById('vid').src)).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const dir = path.join(out, `v${++n}`);
  mkdirSync(dir);
  const webm = path.join(dir, 'v.webm');
  writeFileSync(webm, Buffer.from(b64, 'base64'));
  const dur = Number(/duration=([\d.]+)/.exec(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1', webm]).toString())?.[1] ?? 0);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', webm, '-vf', 'fps=4', path.join(dir, 'f%04d.png')]);
  const frames = readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => hueOf(path.join(dir, f)));
  const runs = [];
  for (const c of frames) if (runs.at(-1)?.c === c) runs.at(-1).n++; else runs.push({ c, n: 1 });
  const longest = (c) => Math.max(0, ...runs.filter((r) => r.c === c).map((r) => r.n / 4));
  return { dur, frames, runs, longest, story: `${dur.toFixed(1)} s: ` + runs.map((r) => `${r.c} ${(r.n / 4).toFixed(1)}s`).join(', ') };
}

// Leave the shop for `ms`: it keeps changing in the background (green), then turns blue before we come back,
// so a green frame in the video can only have come from the time the shop was not the active tab.
async function leaveFor(shop, ms) {
  const other = await ctx.newPage();
  await other.goto(`http://localhost:${PORT}/popup.html`);
  await other.bringToFront();
  const paused = await until(async () => (await state()).privacy, 8000);
  const t = Date.now();
  await paint(shop, GREEN);
  await sleep(ms - 1500);
  await paint(shop, BLUE);
  await sleep(1500);
  await shop.bringToFront();
  const resumed = await until(async () => !(await state()).privacy, 10000);
  await other.close();
  return { paused: !!paused, resumed: !!resumed, pausedMs: Date.now() - t };
}

async function review(sessionId) {
  const rv = await ctx.newPage(); // no viewport override here: in headless Chromium it blacks out the captured tab
  await rv.goto(`chrome-extension://${keyInfo.id}/review.html?session=${sessionId}`);
  await until(() => rv.evaluate(() => { const v = document.getElementById('vid'); return v && v.duration > 0; }), 20000);
  return rv;
}

try {
  await setSettings({ replaySec: 90, tailSec: 0, preSessionSec: 0, openReviewAfterSave: false, markerScreenshot: false, fps: 10 });
  const shop = await ctx.newPage();
  await shop.goto(`http://localhost:${PORT}/`);
  await shop.bringToFront();
  await paint(shop, RED);
  await rd((id) => self.__rd.armTab(id), await activeTabId());

  // ---- Instant Replay: 8 s on the shop, 20 s on another tab, 5 s on the shop, save
  await sleep(8000);
  const away = await leaveFor(shop, 20000);
  ok('switching to another tab puts capture into Privacy Pause, coming back resumes it', away.paused && away.resumed);
  await sleep(5000);
  await rd(() => self.__rd.saveReplay());
  const replay = await until(async () => (await dump('sessions')).find((s) => s.kind === 'instant' && s.status !== 'active'), 20000);
  ok('the replay is saved', !!replay);
  const rv = await review(replay.id);
  const v = await playing(rv);
  ok('no frame from the time the shop was in the background is in the replay', !v.frames.includes('green'), v.story);
  ok('the replay holds the time before (red) and after (blue) the pause', v.frames.includes('red') && v.frames.includes('blue'), v.story);
  ok(`the pause does not stretch the replay (13 s on the shop, ${(away.pausedMs / 1000).toFixed(0)} s away)`, v.dur < 13 + 4.5, v.story);
  ok('the last frame before the pause is not frozen for the length of the pause', v.longest('red') < 10, v.story);
  ok('a short "not recorded" card stands in for the pause, between before and after', v.longest('card') >= 1 && v.longest('card') <= 2.5 && v.runs.findIndex((r) => r.c === 'card') > v.runs.findIndex((r) => r.c === 'red') && v.runs.findIndex((r) => r.c === 'card') < v.runs.findIndex((r) => r.c === 'blue'), v.story);
  const manifestPauses = await rv.evaluate(() => document.getElementById('tl')?.textContent?.includes('Privacy Pause'));
  ok('the timeline lists the Privacy Pause', !!manifestPauses);

  // the timeline follows the video through the card: clicking the row after the pause lands after the card
  const seekOk = await rv.evaluate(() => {
    const rows = [...document.querySelectorAll('#tl [data-i]')];
    const row = rows.filter((r) => /Privacy Pause end/.test(r.textContent ?? '')).at(-1); // the one after the 20 s away, not the blink at arming
    if (!row) return null;
    row.click();
    return document.getElementById('vid').currentTime;
  });
  ok('clicking "Privacy Pause end" seeks to just after the card, not 20 s further', seekOk != null && seekOk > 7 && seekOk < 12, `currentTime ${seekOk}`);

  // ---- the redacted copy uses the same clock: cut 00:01-00:03, preview, the card is still there and nothing is stretched
  await rv.click('#pt-cut');
  await rv.fill('#pt-from', '00:01');
  await rv.fill('#pt-to', '00:03');
  await rv.click('#pt-add');
  await rv.click('#pt-preview');
  await until(() => rv.evaluate(() => /Back to original/.test(document.getElementById('pt-preview')?.textContent ?? '')), 60000);
  await until(() => rv.evaluate(() => { const x = document.getElementById('vid'); return x && x.duration > 0; }), 20000);
  const p = await playing(rv);
  ok('the redacted copy keeps the card, shows nothing from the background and is 2 s shorter', !p.frames.includes('green') && p.longest('card') >= 1 && Math.abs(p.dur - (v.dur - 2)) < 1.2, `${p.story} (original ${v.dur.toFixed(1)} s)`);
  await rv.close();

  // ---- Repro Session (demo step 8): 4 s, 12 s away, 3 s, finish
  await paint(shop, RED);
  await shop.bringToFront(); // the Review tab took the focus: come back to the shop first
  await until(async () => !(await state()).privacy, 10000);
  await sleep(1500);
  await rd(() => self.__rd.startRepro());
  await sleep(4000);
  const away2 = await leaveFor(shop, 12000);
  await sleep(3000);
  await rd(() => self.__rd.finishRepro());
  const repro = await until(async () => (await dump('sessions')).find((s) => s.kind === 'repro' && s.status === 'finished'), 15000);
  ok('the Repro Session finishes', !!repro && away2.paused && away2.resumed);
  const rv2 = await review(repro.id);
  const r = await playing(rv2);
  ok('Repro Session: nothing from the background, the pause is a card and does not stretch the video', !r.frames.includes('green') && r.longest('red') >= 3 && r.longest('card') >= 1 && r.longest('card') <= 2.5 && r.dur < 7 + 4.5, r.story);
} catch (e) {
  console.error('pause-gap e2e aborted:', e instanceof Error ? e.stack : e);
  rep.fail();
} finally {
  await ctx.close().catch(() => undefined);
  server.close();
  rmProfile(userData);
  if (process.env.KEEP_FRAMES) console.log('frames kept in', out); else rmSync(out, { recursive: true, force: true });
  process.exit(rep.summary() ? 1 : 0);
}
