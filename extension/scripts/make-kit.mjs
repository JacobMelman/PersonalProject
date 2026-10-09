// Builds the hand-over kit: one folder (and a zip of it) with everything needed to install and run ReproDesk -
// the release build of the extension, the Northwind Gear demo shop with double-click launchers, and the instructions.
// Run: npm run kit   ->  releases/ReproDesk-Phase0-Kit/  +  releases/ReproDesk-Phase0-Kit.zip
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const proj = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = spawnSync('node', ['scripts/package.mjs'], { cwd: proj, stdio: 'inherit', env: { ...process.env, E2E: '' } }); // release build, no test hooks
if (pkg.status !== 0) process.exit(pkg.status ?? 1);

const name = 'ReproDesk-Phase0-Kit';
const out = path.join(proj, 'releases', name);
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'docs'), { recursive: true });
cpSync(path.join(proj, 'dist'), path.join(out, 'ReproDesk-extension'), { recursive: true });
cpSync(path.join(proj, 'kit', 'demo-shop'), path.join(out, 'demo-shop'), { recursive: true });
cpSync(path.join(proj, 'demo-app'), path.join(out, 'demo-shop', 'site'), { recursive: true });
cpSync(path.join(proj, 'kit', 'INSTALL_AND_RUN.md'), path.join(out, 'INSTALL_AND_RUN.md'));
cpSync(path.join(proj, 'docs', 'DEMO_SCRIPT.md'), path.join(out, 'docs', 'DEMO_SCRIPT.md'));
for (const f of ['start-demo-shop.command', 'start-demo-shop.sh']) chmodSync(path.join(out, 'demo-shop', f), 0o755);

// zip with Unix permissions, so the macOS / Linux launchers stay executable after unpacking
const files = {};
let count = 0;
(function walk(dir, rel) {
  for (const n of readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p, `${rel}${n}/`); continue; }
    files[`${rel}${n}`] = [new Uint8Array(readFileSync(p)), { os: 3, attrs: ((0o100000 | (st.mode & 0o777)) << 16) >>> 0 }];
    count++;
  }
})(out, `${name}/`);
const zip = path.join(proj, 'releases', `${name}.zip`);
writeFileSync(zip, zipSync(files, { level: 6 }));
console.log(`wrote releases/${name}/ and releases/${name}.zip (${count} files, ${(statSync(zip).size / 1048576).toFixed(1)} MB)`);
