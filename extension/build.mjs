// Bundles the extension into dist/. Usage: node build.mjs   (E2E=1 adds the test hook used by Playwright)
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';

const e2e = process.env.E2E === '1';
const outdir = new URL('./dist/', import.meta.url).pathname;
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  outdir,
  target: 'chrome116',
  sourcemap: false,
  minify: false,
  minifySyntax: true, // drops the E2E-only test hook from release builds
  logLevel: 'info',
  define: { __E2E__: JSON.stringify(e2e) },
  loader: { '.svg': 'text' },
};

await build({
  ...common,
  entryPoints: {
    background: 'src/background/index.ts',
    offscreen: 'src/offscreen/index.ts',
    sidepanel: 'src/sidepanel/index.ts',
    review: 'src/review/index.ts',
  },
  format: 'esm',
});
await build({ ...common, entryPoints: { content: 'src/content/index.ts' }, format: 'iife' });

for (const f of ['sidepanel.html', 'review.html', 'offscreen.html', 'styles.css']) {
  cpSync(new URL(`./public/${f}`, import.meta.url).pathname, outdir + f);
}
cpSync(new URL('./public/icons', import.meta.url).pathname, outdir + 'icons', { recursive: true });
cpSync(new URL('./public/fonts', import.meta.url).pathname, outdir + 'fonts', { recursive: true });
if (existsSync(new URL('./public/sample', import.meta.url))) cpSync(new URL('./public/sample', import.meta.url).pathname, outdir + 'sample', { recursive: true });

const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const keyFile = new URL('./manifest.key.json', import.meta.url);
if (existsSync(keyFile)) manifest.key = JSON.parse(readFileSync(keyFile, 'utf8')).key;
if (e2e) {
  manifest.name += ' [E2E]';
  // Test builds get host access to the local fixture origins (the real flow uses activeTab / "Remember this site").
  manifest.host_permissions = ['http://localhost/*', 'http://127.0.0.1/*', ...(process.env.E2E_HOSTS ? process.env.E2E_HOSTS.split(',') : [])];
}
writeFileSync(outdir + 'manifest.json', JSON.stringify(manifest, null, 2));
console.log(`built dist/ (${e2e ? 'E2E' : 'release'})`);
