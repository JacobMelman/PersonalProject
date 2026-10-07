import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error plain ES module without declarations
import { generate, toPlist, toReg } from '../../scripts/gen-policy.mjs';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const policy = {
  AllowedTargetOrigins: ['https://*.corp.example', 'http://localhost:*'], ReplayWindowSec: 60, MarkerScreenshots: false, RequireExportConfirmation: true,
  EnvironmentLabel: 'QA "staging" \\ eu',
};

describe('policy generator', () => {
  it('writes the Linux/Chromium JSON under 3rdparty.extensions.<id>', async () => {
    const files = await generate(policy, { id: ID });
    const j = JSON.parse(files['chrome-linux.json']);
    expect(j['3rdparty'].extensions[ID]).toEqual(policy);
  });
  it('writes Windows registry values with the right types and array sub-keys', () => {
    const reg = toReg(policy, ID, 'Google\\Chrome') as string;
    expect(reg.startsWith('Windows Registry Editor Version 5.00\r\n')).toBe(true);
    expect(reg).toContain(`[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome\\3rdparty\\extensions\\${ID}\\policy]`);
    expect(reg).toContain('"ReplayWindowSec"=dword:0000003c');
    expect(reg).toContain('"MarkerScreenshots"=dword:00000000');
    expect(reg).toContain('"RequireExportConfirmation"=dword:00000001');
    expect(reg).toContain('"EnvironmentLabel"="QA \\"staging\\" \\\\ eu"');
    expect(reg).toContain(`\\policy\\AllowedTargetOrigins]\r\n"1"="https://*.corp.example"\r\n"2"="http://localhost:*"`);
  });
  it('Edge uses its own registry vendor key', async () => {
    expect((await generate(policy, { id: ID }))['edge-windows.reg']).toContain('\\Policies\\Microsoft\\Edge\\3rdparty\\extensions\\');
  });
  it('writes a well-formed plist with typed values', () => {
    const p = toPlist(policy, ID) as string;
    expect(p).toContain(`<key>${ID}</key>`);
    expect(p).toContain('<key>ReplayWindowSec</key><integer>60</integer>');
    expect(p).toContain('<key>MarkerScreenshots</key><false/>');
    expect(p).toContain('<array><string>https://*.corp.example</string><string>http://localhost:*</string></array>');
    expect(p).toContain('<string>QA "staging" \\ eu</string>'); // quotes and backslashes are legal XML text
  });
  it('force-install snippet pins the toolbar icon', async () => {
    const e = JSON.parse((await generate(policy, { id: ID, updateUrl: 'https://updates.corp.example/reprodesk.xml' }))['extension-settings.json']);
    expect(e.ExtensionSettings[ID]).toEqual({ installation_mode: 'force_installed', update_url: 'https://updates.corp.example/reprodesk.xml', toolbar_pin: 'force_pinned' });
  });
  it('refuses an invalid policy and says what is wrong', async () => {
    await expect(generate({ AllowedTargetOrigins: ['corp.example'], ReplayWindowSec: 45 }, { id: ID })).rejects.toThrow(/not a valid origin pattern[\s\S]*ReplayWindowSec must be one of/);
  });
  it('the CLI writes all six files for the shipped example policy', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'rd-pol-'));
    execFileSync('node', ['scripts/gen-policy.mjs', '--out', out], { cwd: path.resolve(__dirname, '../..') });
    expect(readdirSync(out).sort()).toEqual(['chrome-linux.json', 'chrome-macos.plist', 'chrome-windows.reg', 'edge-macos.plist', 'edge-windows.reg', 'extension-settings.json']);
    expect(readFileSync(path.join(out, 'chrome-linux.json'), 'utf8')).toContain('"SessionRetentionDays": 30');
  });
});
