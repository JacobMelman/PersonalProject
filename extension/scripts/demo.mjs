// Demo / dogfood launcher: opens Chromium with the extension loaded, arms it on a page you choose and optionally plays
// a Playwright script (for example one recorded with `npx playwright codegen <url>`).
//
//   npm run demo -- --url https://practicesoftwaretesting.com/ --steps ./scripts/demo-steps.example.mjs
//
// Options: --url <url>  --steps <file>  --repro (record a Repro Session instead of Instant Replay)  --headless
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const proj = path.resolve(here, '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const url = arg('url', 'https://practicesoftwaretesting.com/');
const stepsFile = arg('steps', null);
const origin = new URL(url).origin;

// The demo build is the E2E build plus host access to the demo origin (a real install uses the toolbar click / "Remember this site").
const b = spawnSync('node', ['build.mjs'], { cwd: proj, stdio: 'inherit', env: { ...process.env, E2E: '1', E2E_HOSTS: `${origin}/*` } });
if (b.status !== 0) process.exit(b.status ?? 1);

const key = JSON.parse(readFileSync(path.join(proj, 'manifest.key.json'), 'utf8'));
const userData = mkdtempSync(path.join(tmpdir(), 'rd-demo-'));
const ctx = await chromium.launchPersistentContext(userData, {
  headless: flag('headless'),
  channel: 'chromium',
  args: [`--disable-extensions-except=${path.join(proj, 'dist')}`, `--load-extension=${path.join(proj, 'dist')}`, `--allowlisted-extension-id=${key.id}`, '--no-first-run'],
  viewport: null,
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const page = await ctx.newPage();
await page.goto(url);
await page.bringToFront();
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
await sw.evaluate((id) => self.__rd.armTab(id), tabId);
console.log('Armed:', JSON.stringify(await sw.evaluate(() => self.__rd.state().then((s) => ({ mode: s.mode, terminal: s.terminal, reason: s.reason })))));
await new Promise((r) => setTimeout(r, 2500));
if (flag('repro')) await sw.evaluate(() => self.__rd.startRepro());

if (stepsFile) {
  const mod = await import(pathToFileURL(path.resolve(stepsFile)).href);
  console.log('Running steps from', stepsFile);
  await mod.default(page);
} else if (!flag('headless')) {
  console.log('No --steps given: use the page by hand. Shortcuts: Alt+Shift+R save replay, Alt+Shift+M marker, Alt+Shift+S screenshot, Alt+Shift+P start/finish session.');
}

if (stepsFile || flag('headless')) {
  await new Promise((r) => setTimeout(r, 1500));
  await sw.evaluate(async (repro) => (repro ? self.__rd.finishRepro() : self.__rd.saveReplay()), flag('repro'));
  console.log('Saved. The Review tab opens automatically.');
  await new Promise((r) => setTimeout(r, flag('headless') ? 8000 : 1000));
}
if (!flag('headless')) {
  console.log('Browser stays open. Close it (or press Ctrl+C) to finish.');
  await new Promise((r) => ctx.on('close', r));
} else {
  await ctx.close();
}
rmSync(userData, { recursive: true, force: true });
