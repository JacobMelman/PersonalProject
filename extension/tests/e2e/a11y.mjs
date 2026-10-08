// Accessibility: axe-core on every extension surface (side panel, Review list + detail, editor, privacy tools) in light and dark themes.
// Serious / critical violations fail the run; moderate / minor ones are printed so they stay visible.
import { launch, keyInfo, newReporter, rmProfile, setScheme, sleep, tmpProfile } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const rep = newReporter();
const ok = rep.ok;
const userData = tmpProfile();
const { ctx, dump, until } = await launch(userData, { viewport: { width: 1300, height: 950 } });

async function audit(page, name) {
  for (const scheme of ['light', 'dark']) {
    await setScheme(page, scheme);
    await page.evaluate(axeSource);
    const res = await page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } }));
    const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    const soft = res.violations.filter((v) => !bad.includes(v));
    const fmt = (v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`;
    ok(`${name} [${scheme}]: no serious or critical accessibility violations`, bad.length === 0, bad.map(fmt).join('; '));
    for (const v of soft) console.log(`INFO  ${name} [${scheme}] ${fmt(v)}`);
  }
}

try {
  const sp = await ctx.newPage();
  await sp.setViewportSize({ width: 420, height: 900 });
  await sp.goto(`chrome-extension://${keyInfo.id}/sidepanel.html`);
  await sp.waitForSelector('#load-sample');
  await audit(sp, 'side panel (empty)');
  await sp.click('#load-sample');
  await until(async () => (await dump('sessions')).length >= 2, 20000);
  await sleep(800);
  await audit(sp, 'side panel (sessions)');
  await sp.click('[data-nav="settings"]');
  await sp.waitForSelector('.setrow');
  await audit(sp, 'side panel settings');

  const repro = (await dump('sessions')).find((s) => s.kind === 'repro');
  const rv = await ctx.newPage();
  await rv.setViewportSize({ width: 1300, height: 950 });
  await rv.goto(`chrome-extension://${keyInfo.id}/review.html`);
  await rv.waitForSelector('.scard');
  await audit(rv, 'Review: all sessions');

  await rv.goto(`chrome-extension://${keyInfo.id}/review.html?session=${repro.id}`);
  await until(() => rv.evaluate(() => { const v = document.getElementById('vid'); return v && v.duration > 0; }), 20000);
  await audit(rv, 'Review: session');

  await rv.click('#pt-cut');
  await rv.waitForSelector('#pt-from');
  await audit(rv, 'Review: privacy tools form');
  await rv.click('#pt-cancel');

  await rv.click('[data-edit="1"]');
  await rv.waitForSelector('.editor #ed-canvas');
  await audit(rv, 'screenshot editor');
} catch (e) {
  console.error('a11y e2e aborted:', e instanceof Error ? e.stack : e);
  rep.fail();
} finally {
  await ctx.close().catch(() => undefined);
  rmProfile(userData);
  process.exit(rep.summary() ? 1 : 0);
}
