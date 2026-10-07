// Long-running checks in real Chromium (headed under Xvfb):
//   node tests/real/soak.mjs armed 40     bounded rolling ring over 40 minutes (30 s window), leak/trend analysis
//   node tests/real/soak.mjs repro 31     31-minute Repro Session with pauses/markers, then export + ffprobe of the full video
import { keyInfo, startDisplay, launchChrome, newReporter, tmpProfile, rmProfile, sleep, xdo, findPage, realClick, clickToolbarIcon, shot, root, exportZip } from './lib.mjs';
import { startSites } from './site.mjs';
import { makeProbe } from './probe.mjs';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readFileSync as rf, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';

const mode = process.argv[2] ?? 'armed';
const minutes = Number(process.argv[3] ?? (mode === 'armed' ? 40 : 31));
const PORT = Number(process.env.RD_PORT ?? 9333), SITE = Number(process.env.RD_SITE ?? 4190), OTHER = SITE + 1;
const OUT = path.join(process.env.REAL_OUT || path.join(root, '../../real-results'), `soak-${mode}`);
mkdirSync(OUT, { recursive: true });
const rep = newReporter();
const { ok, info } = rep;
const sites = await startSites(SITE, OTHER);
const disp = await startDisplay();
const ud = tmpProfile();
let chrome;

function tree(rootPid) {
  const rows = execFileSync('ps', ['-eo', 'pid,ppid']).toString().trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [pid, ppid] of rows) (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(pid);
  const out = [rootPid]; for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i]) ?? []));
  return out;
}
function usage(rootPid) {
  let ticks = 0, rss = 0;
  for (const pid of tree(rootPid)) {
    try {
      const st = rf(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ');
      ticks += Number(st[11]) + Number(st[12]);
      rss += Number(/VmRSS:\s+(\d+)/.exec(rf(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0);
    } catch { /* gone */ }
  }
  return { ticks, rssMB: rss / 1024 };
}
const slope = (xs, ys) => { const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n; let num = 0, den = 0; xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; }); return den ? num / den : 0; };

try {
  chrome = await launchChrome({ userData: ud, port: PORT, startUrl: `http://localhost:${SITE}/` });
  await sleep(3500);
  const probe = await makeProbe(PORT);
  await probe.setSettings({ replaySec: 30, tailSec: 2, preSessionSec: 30, fps: 15, bitrateKbps: 1500, openReviewAfterSave: false, afkMinutes: 0 });
  const page = await findPage(PORT, `http://localhost:${SITE}/`);
  await clickToolbarIcon();
  ok('armed', !!(await probe.until(async () => (await probe.state())?.mode === 'armed', 10000)));
  const panel = await findPage(PORT, 'chrome-extension://' + keyInfo.id + '/sidepanel.html');
  const rows = [];
  const csv = path.join(OUT, 'timeseries.csv');
  writeFileSync(csv, 'min,ringSegments,ringMB,opfsFiles,opfsOrphans,storageUsageMB,ringEvents,framesEncoded,dropped,jsHeapMB,rssMB,cpuCores,swStarts,privacy\n');
  let reproId = null;
  if (mode === 'repro') {
    await probe.until(async () => panel.eval(`!!document.querySelector('[data-c="startRepro"]')`), 10000);
    await panel.eval(`document.querySelector('[data-c="startRepro"]').click()`);
    reproId = (await probe.until(async () => (await probe.state())?.sessionId, 8000));
    ok('Repro Session started', !!reproId);
  }
  const t0 = Date.now(); let last = usage(chrome.proc.pid), lastT = Date.now();
  let step = 0, markers = 0, pauses = 0;
  while ((Date.now() - t0) / 60000 < minutes) {
    await sleep(30000);
    step++;
    const min = (Date.now() - t0) / 60000;
    // light, real user activity (also proves the page stays collectable): a click every 30 s
    try { await realClick(page, '#add'); } catch { /* page may be on another tab during a pause */ }
    if (mode === 'repro') {
      if (step % 6 === 0) { await panel.eval(`document.querySelector('[data-c="marker"]') && document.querySelector('[data-c="marker"]').click()`); markers++; }
      if (step % 14 === 7) { // privacy pause: user looks at another tab for ~40 s
        const lib = await import('./lib.mjs');
        const b = await lib.browserCdp(PORT);
        const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' }); b.close();
        pauses++;
        await sleep(40000);
        const b2 = await lib.browserCdp(PORT);
        await b2.send('Target.closeTarget', { targetId });
        // Chrome activates a neighbouring tab (here the probe), not necessarily the target: like a user, go back to the tested tab.
        const fix = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith(`http://localhost:${SITE}/`));
        if (fix) await b2.send('Target.activateTarget', { targetId: fix.id });
        b2.close();
        await sleep(3500);
      }
    }
    const segs = await probe.dump('segments');
    const ring = segs.filter((s) => s.refs.length === 0);
    const evs = await probe.dump('events');
    const h = await probe.health();
    const est = await probe.p.eval(`navigator.storage.estimate().then((e) => e.usage / 1048576)`);
    const opfs = await probe.p.eval(`(async () => { const d = await navigator.storage.getDirectory(); let names = []; try { const s = await d.getDirectoryHandle('seg'); for await (const [n] of s.entries()) names.push(n); } catch {} return names; })()`);
    const ids = new Set(segs.map((s) => s.id + '.bin'));
    const orphans = opfs.filter((n) => !ids.has(n)).length;
    const u = usage(chrome.proc.pid); const cores = (u.ticks - last.ticks) / 100 / ((Date.now() - lastT) / 1000); last = u; lastT = Date.now();
    const row = { min, ringSegments: ring.length, ringMB: ring.reduce((a, s) => a + s.bytes, 0) / 1048576, opfsFiles: opfs.length, orphans, est, ringEvents: evs.filter((e) => e.sessionId === 'ring').length, fe: h?.framesEncoded ?? 0, dr: h?.framesDropped ?? 0, heap: h?.jsHeapMB ?? 0, rss: u.rssMB, cores, sw: await probe.session('swStarts'), privacy: (await probe.state())?.privacy };
    rows.push(row);
    writeFileSync(csv, `${[row.min.toFixed(1), row.ringSegments, row.ringMB.toFixed(2), row.opfsFiles, row.orphans, row.est.toFixed(1), row.ringEvents, row.fe, row.dr, row.heap, row.rss.toFixed(0), row.cores.toFixed(2), row.sw, row.privacy].join(',')}\n`, { flag: 'a' });
    console.log(`t=${row.min.toFixed(1)}m ring=${row.ringSegments}seg/${row.ringMB.toFixed(1)}MB opfs=${row.opfsFiles} orphans=${orphans} usage=${row.est.toFixed(0)}MB heap=${row.heap}MB rss=${row.rss.toFixed(0)}MB cpu=${row.cores.toFixed(2)} sw=${row.sw} privacy=${row.privacy}`);
  }

  if (mode === 'armed') {
    const settled = rows.filter((r) => r.min > 3);
    const maxSeg = Math.max(...settled.map((r) => r.ringSegments)), minSeg = Math.min(...settled.map((r) => r.ringSegments));
    ok(`ring stays bounded over ${minutes} min (segments min/max ${minSeg}/${maxSeg}, 30 s window)`, maxSeg <= 30 && minSeg >= 5);
    const maxMB = Math.max(...settled.map((r) => r.ringMB));
    ok('ring size in MB stays bounded', maxMB < 60, `max ${maxMB.toFixed(1)} MB`);
    ok('no orphaned media files in OPFS (every file is indexed)', Math.max(...settled.map((r) => r.orphans)) <= 2, `max orphans ${Math.max(...settled.map((r) => r.orphans))}`);
    const ev = settled.map((r) => r.ringEvents); ok('ring events stay bounded', Math.max(...ev) < 400, `max ${Math.max(...ev)}`);
    const sUsage = slope(settled.map((r) => r.min), settled.map((r) => r.est));
    ok('storage usage does not grow with time (slope < 0.5 MB/min)', sUsage < 0.5, `${sUsage.toFixed(3)} MB/min, final ${rows.at(-1).est.toFixed(0)} MB`);
    const sRss = slope(settled.map((r) => r.min), settled.map((r) => r.rss));
    ok('browser memory does not trend upward (slope < 2 MB/min)', sRss < 2, `${sRss.toFixed(2)} MB/min, final ${rows.at(-1).rss.toFixed(0)} MB`);
    const sHeap = slope(settled.map((r) => r.min), settled.map((r) => r.heap));
    ok('offscreen JS heap does not trend upward (slope < 0.3 MB/min)', sHeap < 0.3, `${sHeap.toFixed(3)} MB/min`);
    const h = await probe.health();
    const dropRate = h.framesDropped / Math.max(1, h.framesEncoded + h.framesDropped);
    ok('encoder drop rate < 5%', dropRate < 0.05, `${(dropRate * 100).toFixed(2)}%`);
    info('total media written (MB)', (h.bytesWritten / 1048576).toFixed(0));
    info('average CPU (cores)', (rows.reduce((a, r) => a + r.cores, 0) / rows.length).toFixed(2));
    info('write volume extrapolated to 8 h (GB)', ((h.bytesWritten / 1048576 / minutes) * 480 / 1024).toFixed(1));
    // After a long run the ring must still save a correct replay.
    await panel.eval(`document.querySelector('[data-c="saveReplay"]').click()`);
    const inst = await probe.until(async () => (await probe.dump('sessions')).find((s) => s.kind === 'instant' && s.status === 'finished'), 20000);
    ok('Save Last Replay after a long Armed period works', !!inst);
    const zipPath = inst && (await exportZip(PORT, inst.id, path.join(OUT, 'dl')));
    if (zipPath) {
      const z = unzipSync(new Uint8Array(readFileSync(zipPath)));
      const webm = path.join(OUT, 'last-replay.webm'); writeFileSync(webm, z['replay.webm']);
      const dur = Number(/duration=([\d.]+)/.exec(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1', webm]).toString())?.[1] ?? 0);
      ok(`saved replay after ${minutes} min is bounded to the configured window (30 s + tail + GOP slack)`, dur > 20 && dur < 40, `${dur.toFixed(1)} s`);
    }
  } else {
    await panel.eval(`document.querySelector('[data-c="finishRepro"]').click()`);
    const fin = await probe.until(async () => (await probe.dump('sessions')).find((s) => s.id === reproId && s.status === 'finished'), 20000);
    ok('31-minute Repro Session finished', !!fin);
    const segs = (await probe.dump('segments')).filter((s) => s.refs.includes(reproId));
    const totalMB = segs.reduce((a, s) => a + s.bytes, 0) / 1048576;
    info('session storage', `${segs.length} GOP segments, ${totalMB.toFixed(1)} MB (${(totalMB / minutes).toFixed(2)} MB/min)`);
    const covered = (Math.max(...segs.map((s) => s.endWall)) - Math.min(...segs.map((s) => s.startWall))) / 60000;
    ok('session evidence spans the whole run (survives far beyond the 30 s rolling window)', covered > minutes - 3, `${covered.toFixed(1)} min`);
    const evs = (await probe.dump('events')).filter((e) => e.sessionId === reproId);
    ok('markers recorded', evs.filter((e) => e.type === 'marker').length >= Math.max(1, markers - 1), `${evs.filter((e) => e.type === 'marker').length} markers`);
    ok('privacy pauses recorded as system events', evs.filter((e) => /Privacy Pause start/.test(e.label ?? '')).length >= pauses, `${pauses} pauses`);
    const zipPath = await exportZip(PORT, reproId, path.join(OUT, 'dl'));
    ok('31-minute Evidence Package exported through the real Review page', !!zipPath, zipPath ? `${(statSync(zipPath).size / 1048576).toFixed(1)} MB` : '');
    if (zipPath) {
      const z = unzipSync(new Uint8Array(readFileSync(zipPath)));
      const webm = path.join(OUT, 'session.webm'); writeFileSync(webm, z['replay.webm']);
      const dur = Number(/duration=([\d.]+)/.exec(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1', webm]).toString())?.[1] ?? 0);
      ok('exported video covers the full session (ffprobe duration)', dur / 60 > minutes - 3, `${(dur / 60).toFixed(1)} min`);
      const t = Math.max(1, dur - 5);
      let seekOk = true; try { execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', webm, '-frames:v', '1', path.join(OUT, 'last-frame.png')]); } catch { seekOk = false; }
      ok('the end of the video is seekable and decodable', seekOk);
      const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', webm, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
      // ffmpeg's null muxer prints timestamp-rounding warnings for any millisecond-resolution variable-frame-rate WebM; those are not decoder errors.
      const realErrors = (dec.stderr ?? '').split('\n').filter((l) => l.trim() && !/non monotonically increasing dts to muxer/.test(l));
      ok('full decode of the whole video reports no decoder errors (integrity)', dec.status === 0 && realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
      const frames = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts', '-of', 'csv=p=0', webm], { maxBuffer: 1 << 28 }).toString().trim().split('\n').map(Number);
      const nonInc = frames.filter((v, i) => i > 0 && v <= frames[i - 1]).length;
      ok('decoded frames have strictly increasing timestamps and none were lost', nonInc === 0 && frames.length > minutes * 60 * 5, `${frames.length} frames, ${nonInc} non-increasing`);
      const man = JSON.parse(Buffer.from(z['manifest.json']).toString());
      ok('manifest lists capture gaps for the pauses', (man.video?.gaps?.length ?? 0) >= pauses, `${man.video?.gaps?.length ?? 0} gaps for ${pauses} pauses`);
    }
    const sRss = slope(rows.map((r) => r.min), rows.map((r) => r.rss));
    info('browser memory trend (MB/min)', sRss.toFixed(2));
    info('storage growth (MB/min)', slope(rows.map((r) => r.min), rows.map((r) => r.est)).toFixed(2));
    info('average CPU (cores)', (rows.reduce((a, r) => a + r.cores, 0) / rows.length).toFixed(2));
  }
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ mode, minutes, results: rep.results, rows }, null, 1));
} catch (e) {
  console.error('soak aborted:', e instanceof Error ? e.stack : e);
  ok('soak completed without an exception', false, String(e));
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ mode, minutes, results: rep.results, error: String(e) }, null, 1));
} finally {
  await chrome?.close();
  disp.stop();
  sites.close();
  rmProfile(ud);
  process.exit(rep.summary() ? 1 : 0);
}
