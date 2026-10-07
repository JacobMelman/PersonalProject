// Where does the slow browser-memory growth seen in the 40-minute Armed soak come from? One real Chromium session, three phases on the
// same animated page, memory sampled per process class (anonymous RSS, i.e. without shared file mappings):
//   phase 1  extension loaded, NOT armed        -> baseline of Chrome + page itself
//   phase 2  armed (tab capture + encoder + ring)
//   phase 3  disarmed again                      -> does memory come back / stop growing?
//   node tests/real/memslope.mjs 8 14 8          (minutes per phase)
import { keyInfo, startDisplay, launchChrome, newReporter, tmpProfile, rmProfile, sleep, findPage, clickToolbarIcon, root } from './lib.mjs';
import { startSites } from './site.mjs';
import { makeProbe } from './probe.mjs';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [m1, m2, m3] = [8, 14, 8].map((d, i) => Number(process.argv[2 + i] ?? d));
const PORT = Number(process.env.RD_PORT ?? 9333), SITE = Number(process.env.RD_SITE ?? 4190);
const OUT = path.join(root, '../../docs/phase0-results/memslope');
mkdirSync(OUT, { recursive: true });
const rep = newReporter();
const sites = await startSites(SITE, SITE + 1);
const disp = await startDisplay();
const ud = tmpProfile();
let chrome;

const kidsOf = (rootPid) => {
  const rows = execFileSync('ps', ['-eo', 'pid,ppid']).toString().trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [pid, ppid] of rows) (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(pid);
  const out = [rootPid]; for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i]) ?? []));
  return out;
};
const classify = (cmd) => {
  const t = /--type=([\w-]+)/.exec(cmd)?.[1];
  if (!t) return 'browser';
  if (t === 'renderer') return /--extension-process/.test(cmd) ? 'extension-renderer' : 'page-renderer';
  if (t === 'gpu-process') return 'gpu';
  if (t === 'utility') return 'utility';
  return t; // zygote, ...
};
const sample = () => {
  const by = {};
  for (const pid of kidsOf(chrome.proc.pid)) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      const st = readFileSync(`/proc/${pid}/status`, 'utf8');
      const anon = Number(/RssAnon:\s+(\d+)/.exec(st)?.[1] ?? 0) / 1024;
      const c = classify(cmd);
      by[c] = (by[c] ?? 0) + anon;
    } catch { /* process gone */ }
  }
  by.total = Object.values(by).reduce((a, b) => a + b, 0);
  return by;
};
const slope = (xs, ys) => { const n = xs.length; if (n < 3) return 0; const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n; let num = 0, den = 0; xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; }); return den ? num / den : 0; };

try {
  chrome = await launchChrome({ userData: ud, port: PORT, startUrl: `http://localhost:${SITE}/` });
  await sleep(3500);
  const probe = await makeProbe(PORT);
  await probe.setSettings({ replaySec: 30, tailSec: 0, preSessionSec: 0, fps: 15, bitrateKbps: 1500, openReviewAfterSave: false, afkMinutes: 0 });
  const rows = [];
  const classes = new Set();
  const runPhase = async (name, minutes) => {
    const t0 = Date.now();
    console.log(`--- phase ${name} (${minutes} min)`);
    while ((Date.now() - t0) / 60000 < minutes) {
      await sleep(20000);
      const s = sample();
      Object.keys(s).forEach((k) => classes.add(k));
      rows.push({ phase: name, min: (Date.now() - t0) / 60000, ...s });
      console.log(`${name} t=${((Date.now() - t0) / 60000).toFixed(1)}m ${Object.entries(s).map(([k, v]) => `${k}=${v.toFixed(0)}`).join(' ')}`);
    }
  };
  await runPhase('idle', m1);
  await clickToolbarIcon();
  rep.ok('armed for phase 2', !!(await probe.until(async () => (await probe.state())?.mode === 'armed', 10000)));
  await runPhase('armed', m2);
  await probe.p.eval(`chrome.runtime.sendMessage({ kind: 'cmd', cmd: 'disarm' })`);
  rep.ok('disarmed for phase 3', !!(await probe.until(async () => (await probe.state())?.mode === 'inactive', 15000)));
  await runPhase('disarmed', m3);

  const WARM = 2.5; // minutes ignored at the start of each phase
  const table = {};
  for (const phase of ['idle', 'armed', 'disarmed']) {
    const pr = rows.filter((r) => r.phase === phase && r.min > WARM);
    table[phase] = Object.fromEntries([...classes].map((c) => [c, +slope(pr.map((r) => r.min), pr.map((r) => r[c] ?? 0)).toFixed(3)]));
  }
  console.log('\nslope in MB/min of anonymous RSS (after the first 2.5 min of each phase)');
  console.table(table);
  writeFileSync(path.join(OUT, 'slopes.json'), JSON.stringify({ minutes: { idle: m1, armed: m2, disarmed: m3 }, slopesMBperMin: table, chrome: 'Chromium (Playwright build) under Xvfb', samples: rows }, null, 1));
  writeFileSync(path.join(OUT, 'samples.csv'), ['phase,min,' + [...classes].join(','), ...rows.map((r) => `${r.phase},${r.min.toFixed(2)},${[...classes].map((c) => (r[c] ?? 0).toFixed(1)).join(',')}`)].join('\n'));
} catch (e) {
  console.error('memslope aborted:', e instanceof Error ? e.stack : e);
  rep.ok('memslope completed', false, String(e instanceof Error ? e.message : e));
} finally {
  await chrome?.close().catch(() => undefined);
  disp.stop(); sites.close(); rmProfile(ud);
  process.exit(rep.summary() ? 1 : 0);
}
