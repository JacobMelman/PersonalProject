// Builds the release bundle and zips dist/ into releases/ so it can be unpacked and loaded without Node.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const proj = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const b = spawnSync('node', ['build.mjs'], { cwd: proj, stdio: 'inherit', env: { ...process.env, E2E: '' } });
if (b.status !== 0) process.exit(b.status ?? 1);
const dist = path.join(proj, 'dist');
const files = {};
(function walk(dir, rel = '') {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, rel + n + '/');
    else files[rel + n] = new Uint8Array(readFileSync(p));
  }
})(dist);
const version = JSON.parse(readFileSync(path.join(proj, 'manifest.json'), 'utf8')).version;
mkdirSync(path.join(proj, 'releases'), { recursive: true });
const out = path.join(proj, 'releases', `reprodesk-phase0-v${version}.zip`);
writeFileSync(out, zipSync(files, { level: 6 }));
console.log('wrote', path.relative(proj, out), `(${Object.keys(files).length} files)`);
