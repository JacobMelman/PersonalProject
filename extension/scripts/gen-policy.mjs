// Turns one policy JSON (see policy/example-policy.json) into the files administrators actually deploy:
//   node scripts/gen-policy.mjs [policy.json] [--id <extension id>] [--out <dir>] [--update-url <url>]
// Output (default dir: policy/out):
//   chrome-linux.json       -> /etc/opt/chrome/policies/managed/reprodesk.json   (Chromium: /etc/chromium/policies/managed/)
//   chrome-windows.reg      -> import on a test machine, or deploy the same values through GPO (Chrome ADMX 3rdparty) / Intune
//   edge-windows.reg        -> same for Microsoft Edge
//   chrome-macos.plist, edge-macos.plist -> Managed Preferences / configuration profile payload
//   extension-settings.json -> the ExtensionSettings policy that force-installs and pins ReproDesk
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const proj = path.resolve(here, '..');
const DEV_ID = JSON.parse(readFileSync(path.join(proj, 'manifest.key.json'), 'utf8')).id;

async function loadPolicyModule() {
  const { code } = await transform(readFileSync(path.join(proj, 'src/shared/policy.ts'), 'utf8'), { loader: 'ts', format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}

const regStr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const dword = (n) => `dword:${(n >>> 0).toString(16).padStart(8, '0')}`;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toReg(policy, id, vendorKey) {
  const base = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\${vendorKey}\\3rdparty\\extensions\\${id}\\policy`;
  const scalars = [];
  const arrays = [];
  for (const [k, v] of Object.entries(policy)) {
    if (Array.isArray(v)) arrays.push([k, v]);
    else if (typeof v === 'boolean') scalars.push(`${regStr(k)}=${dword(v ? 1 : 0)}`);
    else if (typeof v === 'number') scalars.push(`${regStr(k)}=${dword(v)}`);
    else scalars.push(`${regStr(k)}=${regStr(v)}`);
  }
  let out = `Windows Registry Editor Version 5.00\r\n\r\n[${base}]\r\n${scalars.join('\r\n')}\r\n`;
  for (const [k, list] of arrays) out += `\r\n[${base}\\${k}]\r\n${list.map((v, i) => `${regStr(String(i + 1))}=${regStr(v)}`).join('\r\n')}\r\n`;
  return out;
}

export function toPlist(policy, id) {
  const val = (v) =>
    Array.isArray(v) ? `<array>${v.map((x) => `<string>${xml(x)}</string>`).join('')}</array>`
    : typeof v === 'boolean' ? (v ? '<true/>' : '<false/>')
    : typeof v === 'number' ? `<integer>${v}</integer>`
    : `<string>${xml(v)}</string>`;
  const body = Object.entries(policy).map(([k, v]) => `<key>${xml(k)}</key>${val(v)}`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>3rdparty</key><dict><key>extensions</key><dict><key>${id}</key><dict>${body}</dict></dict></dict></dict></plist>\n`;
}

export const toLinuxJson = (policy, id) => JSON.stringify({ '3rdparty': { extensions: { [id]: policy } } }, null, 2) + '\n';
export const toExtensionSettings = (id, updateUrl) =>
  JSON.stringify({ ExtensionSettings: { [id]: { installation_mode: 'force_installed', update_url: updateUrl, toolbar_pin: 'force_pinned' } } }, null, 2) + '\n';

export async function generate(rawPolicy, { id = DEV_ID, updateUrl = 'https://clients2.google.com/service/update2/crx', out } = {}) {
  const { validateRawPolicy } = await loadPolicyModule();
  const problems = validateRawPolicy(rawPolicy);
  if (problems.length) throw new Error('Invalid policy:\n - ' + problems.join('\n - '));
  const files = {
    'chrome-linux.json': toLinuxJson(rawPolicy, id),
    'chrome-windows.reg': toReg(rawPolicy, id, 'Google\\Chrome'),
    'edge-windows.reg': toReg(rawPolicy, id, 'Microsoft\\Edge'),
    'chrome-macos.plist': toPlist(rawPolicy, id),
    'edge-macos.plist': toPlist(rawPolicy, id),
    'extension-settings.json': toExtensionSettings(id, updateUrl),
  };
  if (out) {
    mkdirSync(out, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(out, name), text);
  }
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const id = opt('--id') ?? DEV_ID;
  const out = path.resolve(opt('--out') ?? path.join(proj, 'policy/out'));
  const updateUrl = opt('--update-url') ?? 'https://clients2.google.com/service/update2/crx';
  const file = args[0] ?? path.join(proj, 'policy/example-policy.json');
  try {
    const files = await generate(JSON.parse(readFileSync(file, 'utf8')), { id, updateUrl, out });
    console.log(`Policy from ${path.relative(process.cwd(), file)} for extension ${id}${id === DEV_ID ? ' (development id - pass --id <store id> for production)' : ''}`);
    for (const n of Object.keys(files)) console.log('  wrote', path.join(path.relative(process.cwd(), out), n));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
