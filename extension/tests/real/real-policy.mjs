// Enterprise policy through the REAL channel: a managed-policy JSON file that Chromium itself loads (same mechanism as GPO / Intune / MDM),
// the extension's managed-storage schema, a genuine toolbar click, and a policy change while the browser is running.
//   needs write access to /etc/chromium/policies/managed (this rig runs as root); the file is removed afterwards.
import { keyInfo, startDisplay, launchChrome, newReporter, tmpProfile, rmProfile, sleep, findPage, clickToolbarIcon, shot, root } from './lib.mjs';
import { startSites } from './site.mjs';
import { generate } from '../../scripts/gen-policy.mjs';
import { makeProbe } from './probe.mjs';
import path from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';

const PORT = Number(process.env.RD_PORT ?? 9333), SITE = Number(process.env.RD_SITE ?? 4190), OTHER = SITE + 1;
const OUT = process.env.REAL_OUT || path.join(root, '../../real-results');
mkdirSync(OUT, { recursive: true });
const POLICY_DIR = process.env.RD_POLICY_DIR || '/etc/chromium/policies/managed';
const POLICY_FILE = path.join(POLICY_DIR, 'reprodesk-test.json');
// The file is produced by the same generator administrators use, so the generator itself is covered by the real channel.
const writePolicy = async (p) => writeFileSync(POLICY_FILE, (await generate(p, { id: keyInfo.id }))['chrome-linux.json']);
const rep = newReporter();
const { ok } = rep;
const sites = await startSites(SITE, OTHER);
const disp = await startDisplay();
const ud = tmpProfile();
let chrome;
mkdirSync(POLICY_DIR, { recursive: true });
await writePolicy({ BlockedOrigins: ['http://localhost:*'], ReplayWindowSec: 60, EnvironmentLabel: 'Managed QA' });
try {
  chrome = await launchChrome({ userData: ud, port: PORT, startUrl: `http://localhost:${SITE}/` });
  await sleep(3500);
  const probe = await makeProbe(PORT);
  const managed = () => probe.p.eval(`chrome.storage.managed.get(null)`);
  const got = await probe.until(async () => Object.keys(await managed()).length > 0, 15000);
  ok('Chromium delivered the policy file to the extension\'s managed storage (schema accepted)', !!got, JSON.stringify(await managed()));
  const m1 = await managed();
  ok('values arrive typed as the schema says', m1.ReplayWindowSec === 60 && m1.EnvironmentLabel === 'Managed QA' && Array.isArray(m1.BlockedOrigins) && m1.BlockedOrigins[0] === 'http://localhost:*', JSON.stringify(m1));

  // phase A: the site is blocked -> a genuine toolbar click must not arm
  await clickToolbarIcon();
  await sleep(2500);
  const st = await probe.state();
  ok('REAL toolbar click on a blocked site does not arm ReproDesk', (st?.mode ?? 'inactive') === 'inactive', JSON.stringify({ state: st ? st.mode : 'never armed' }));
  const note = await probe.session('notice');
  ok('the user gets an explanation that names the organization', !!note && /organization/i.test(note.text), note?.text);
  const panel = await findPage(PORT, 'chrome-extension://' + keyInfo.id + '/sidepanel.html');
  ok('the side panel opened by the click shows nothing recording', !!panel && (await panel.eval(`!document.querySelector('[data-c="saveReplay"]')`)));
  await panel.eval(`document.querySelector('[data-nav="settings"]').click()`);
  await sleep(700);
  ok('settings show the managed banner and the locked, policy-set replay window', (await panel.eval(`!!document.getElementById('managed-banner') && document.querySelector('[data-seg="replaySec"].on').textContent.trim()`)) === '60s');
  shot(path.join(OUT, '60-managed-settings.png'));
  await panel.eval(`document.querySelector('[data-nav="main"]').click()`);

  // phase B: the administrator changes the policy while the browser runs
  await writePolicy({ AllowedTargetOrigins: ['http://localhost:*'], ReplayWindowSec: 30, AllowedExportFormats: ['zip', 'html'], RequireExportConfirmation: true });
  const changed = await probe.until(async () => (await managed()).ReplayWindowSec === 30, 40000, 1000);
  ok('a changed policy file is picked up without restarting the browser', !!changed, JSON.stringify(await managed()));
  const m2 = await managed();
  ok('removed policies disappear from managed storage', m2.BlockedOrigins === undefined && m2.EnvironmentLabel === undefined, JSON.stringify(m2));
  await clickToolbarIcon();
  ok('REAL toolbar click on an allowed site arms ReproDesk', !!(await probe.until(async () => (await probe.state())?.mode === 'armed', 10000)));
  const panel2 = await findPage(PORT, 'chrome-extension://' + keyInfo.id + '/sidepanel.html');
  await sleep(1200);
  ok('the panel offers capture again', !!panel2 && (await panel2.eval(`!!document.querySelector('[data-c="saveReplay"]')`)));

  // phase C: tighten the policy under a running capture
  await writePolicy({ BlockedOrigins: ['http://localhost:*'] });
  const stopped = await probe.until(async () => (await probe.state())?.mode === 'inactive', 40000, 1000);
  ok('tightening the policy while armed stops the capture without any user action', !!stopped);
  const note2 = await probe.session('notice');
  ok('and tells the user why', !!note2 && /disarmed/i.test(note2.text), note2?.text);
  shot(path.join(OUT, '61-policy-disarmed.png'));
} catch (e) {
  console.error('real-policy aborted:', e instanceof Error ? e.stack : e);
  ok('suite completed without an exception', false, String(e));
} finally {
  rmSync(POLICY_FILE, { force: true });
  await chrome?.close().catch(() => undefined);
  disp.stop(); sites.close(); rmProfile(ud);
  if (existsSync(POLICY_FILE)) console.log('WARNING: could not remove', POLICY_FILE);
  process.exit(rep.summary() ? 1 : 0);
}
