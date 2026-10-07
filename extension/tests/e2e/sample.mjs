// Sample sessions: load the bundled, pre-recorded demo run, prove it behaves like real evidence (playable, steps, screenshots, redaction,
// export), is clearly labelled, loads idempotently and leaves no trace once removed.
import { launch, keyInfo, newReporter, rmProfile, sleep, tmpProfile } from './lib.mjs';
import { unzipSync, strFromU8 } from 'fflate';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const rep = newReporter();
const ok = rep.ok;
const userData = tmpProfile();
const { ctx, dump, until } = await launch(userData, { viewport: { width: 1300, height: 950 } });
const out = mkdtempSync(path.join(tmpdir(), 'rd-sample-'));

try {
  const sp = await ctx.newPage();
  await sp.setViewportSize({ width: 420, height: 900 });
  await sp.goto(`chrome-extension://${keyInfo.id}/sidepanel.html`);
  await sp.waitForSelector('#load-sample');
  ok('empty state offers to try sample sessions', /Try with sample sessions/.test(await sp.locator('#load-sample').innerText()));
  await sp.click('#load-sample');
  await until(async () => (await dump('sessions')).length >= 2, 20000);
  await sleep(800);
  const sessions = await dump('sessions');
  ok('two sample sessions were created (Instant Replay + Repro Session)', sessions.length === 2 && sessions.some((s) => s.kind === 'instant') && sessions.some((s) => s.kind === 'repro'));
  ok('every sample session is flagged and finished', sessions.every((s) => s.sample === true && s.status === 'finished'));
  const now = Date.now();
  ok('sample sessions are re-dated to just now', sessions.every((s) => now - s.endedAt < 6 * 60_000 && s.endedAt <= now), sessions.map((s) => Math.round((now - s.endedAt) / 1000) + 's ago').join(', '));
  const repro = sessions.find((s) => s.kind === 'repro');
  const segs = await dump('segments');
  ok('video segments are pinned to the sample sessions', segs.length >= 8 && segs.every((s) => s.refs.length === 1 && sessions.some((x) => x.id === s.refs[0])), `${segs.length} segments`);
  ok('segment timestamps were shifted along with the session', segs.every((s) => s.endWall <= now && s.endWall >= repro.startedAt - 60_000));
  const shots = await dump('shots');
  ok('two marker screenshots with intact annotations list', shots.length === 2 && shots.every((s) => s.sessionId === repro.id && Array.isArray(s.annotations) && s.annotations.length === 0));
  const evs = (await dump('events')).filter((e) => e.sessionId === repro.id);
  ok('timeline has clicks, markers and screenshot links', evs.filter((e) => e.type === 'click').length >= 5 && evs.filter((e) => e.type === 'marker').length === 2 && evs.filter((e) => e.type === 'screenshot').every((e) => shots.some((s) => s.id === e.evidenceId)));
  ok('panel lists both sessions with a Sample badge', (await sp.locator('.session .badge', { hasText: 'Sample' }).count()) === 2);
  ok('events never leak the local origin of the recording rig', !/localhost/.test(JSON.stringify(await dump('events'))));

  // ---- the Review page treats it like any other evidence
  const rv = await ctx.newPage();
  await rv.setViewportSize({ width: 1300, height: 950 });
  await rv.goto(`chrome-extension://${keyInfo.id}/review.html?session=${repro.id}`);
  const dur = await until(() => rv.evaluate(() => { const v = document.getElementById('vid'); return v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0; }), 20000);
  ok('sample replay is playable in the Review page', !!dur && dur > 12, `${dur?.toFixed?.(1)} s`);
  ok('Review page labels it as a sample', /Sample session/.test(await rv.locator('.callout.sample').innerText()));
  ok('report title and fields come with the sample', /\[Sample\] Promo code SUMMER20/.test(await rv.inputValue('#f-title')) && /E-4021/.test(await rv.inputValue('#f-actual')) && (await rv.inputValue('#f-exp')).length > 20);
  const steps = await rv.locator('.steps li').count();
  ok('steps to reproduce are drafted from the sample events', steps >= 5, `${steps} steps`);
  ok('both screenshots are in the gallery', (await rv.locator('.gallery .shot').count()) === 2);

  // ---- redaction on sample data: mask the upper part of the video and export
  await rv.click('#pt-mask');
  await rv.waitForSelector('.maskdraw');
  await sleep(250);
  const g = await rv.evaluate(() => { const r = document.getElementById('vid').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vw: document.getElementById('vid').videoWidth, vh: document.getElementById('vid').videoHeight }; });
  const ar = g.vw / g.vh; let cw = g.w, ch = g.h; if (g.w / g.h > ar) cw = g.h * ar; else ch = g.w / ar;
  const cx = g.x + (g.w - cw) / 2, cy = g.y + (g.h - ch) / 2;
  await rv.mouse.move(cx + cw * 0.05, cy + ch * 0.12);
  await rv.mouse.down();
  await rv.mouse.move(cx + cw * 0.95, cy + ch * 0.45, { steps: 8 });
  await rv.mouse.up();
  await rv.waitForSelector('#pt-add');
  await rv.click('#pt-type [data-t="redact"]');
  await rv.fill('#pt-from', '0:00');
  await rv.fill('#pt-to', '9:00');
  await rv.click('#pt-add');
  await rv.waitForSelector('#pt-list [data-rm-mask]');
  const dl = [];
  rv.on('download', (d) => dl.push(d));
  await rv.evaluate(() => document.querySelectorAll('[data-fmt]').forEach((c) => (c.checked = c.dataset.fmt === 'zip')));
  await rv.click('#export');
  await until(async () => dl.length >= 1, 90000);
  const zp = path.join(out, 'sample.zip'); await dl[0].saveAs(zp);
  const z = unzipSync(new Uint8Array(readFileSync(zp)));
  const man = JSON.parse(strFromU8(z['manifest.json']));
  ok('exported sample package records the mask and the sample flag', man.video?.redacted?.masks === 1 && JSON.parse(strFromU8(z['session.json'])).sample === true);
  const webm = path.join(out, 'sample.webm'); writeFileSync(webm, z['replay.webm']);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'default=nw=1', webm]).toString();
  const w = Number(/width=(\d+)/.exec(probe)[1]), h = Number(/height=(\d+)/.exec(probe)[1]);
  ok('re-dated segments decode and re-encode into a valid video', /codec_name=vp/.test(probe) && Number(/duration=([\d.]+)/.exec(probe)[1]) > 8, probe.replace(/\n/g, ' '));
  const png = path.join(out, 'f.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '3', '-i', webm, '-frames:v', '1', png]);
  const mean = Number(execFileSync('convert', [png, '-crop', `${Math.round(w * 0.85)}x${Math.round(h * 0.28)}+${Math.round(w * 0.08)}+${Math.round(h * 0.15)}`, '+repage', '-format', '%[fx:mean]', 'info:']).toString());
  ok('masked area of the sample video is black in the export', mean < 0.03, `mean ${mean.toFixed(3)}`);

  // ---- idempotent reload
  const firstIds = new Set(sessions.map((s) => s.id));
  await sp.reload();
  await sp.waitForSelector('[data-nav="settings"]');
  await sp.click('[data-nav="settings"]');
  await sp.waitForSelector('#load-sample');
  ok('settings offer to reload or remove the sample', /Reload sample sessions/.test(await sp.locator('#load-sample').innerText()) && (await sp.locator('#remove-sample').count()) === 1);
  await sp.click('#load-sample');
  await until(async () => { const s = await dump('sessions'); return s.length === 2 && s.every((x) => !firstIds.has(x.id)); }, 20000);
  await sleep(600);
  ok('reloading replaces the sample instead of duplicating it', (await dump('sessions')).length === 2 && (await dump('shots')).length === 2, `${(await dump('segments')).length} segments`);

  // ---- remove leaves nothing behind
  await sp.click('#remove-sample');
  await until(async () => (await dump('sessions')).length === 0, 20000);
  await sleep(600);
  const left = { sessions: (await dump('sessions')).length, segments: (await dump('segments')).length, shots: (await dump('shots')).length, events: (await dump('events')).length, reports: (await dump('reports')).length };
  ok('removing the sample deletes sessions, segments, screenshots, events and reports', Object.values(left).every((n) => n === 0), JSON.stringify(left));
  const files = await sp.evaluate(async () => {
    const root = await navigator.storage.getDirectory(); const names = [];
    for (const d of ['seg', 'shots']) { try { const h = await root.getDirectoryHandle(d); for await (const k of h.keys()) names.push(d + '/' + k); } catch { /* none */ } }
    return names;
  });
  ok('and no media files remain in OPFS', files.length === 0, files.slice(0, 3).join(','));
} catch (e) {
  console.error('sample e2e aborted:', e instanceof Error ? e.stack : e);
  rep.fail();
} finally {
  await ctx.close().catch(() => undefined);
  rmProfile(userData);
  process.exit(rep.summary() ? 1 : 0);
}
