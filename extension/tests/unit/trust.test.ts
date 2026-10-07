import { describe, expect, it } from 'vitest';
import { isOwnContentScript, isOwnExtensionPage, isRememberableOrigin } from '../../src/shared/trust';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const BASE = `chrome-extension://${ID}/`;

describe('isOwnExtensionPage', () => {
  it('accepts the side panel, Review and offscreen pages of this extension', () => {
    for (const p of ['sidepanel.html', 'review.html?session=s_1', 'offscreen.html']) expect(isOwnExtensionPage({ id: ID, url: BASE + p }, ID, BASE)).toBe(true);
  });
  it('rejects content scripts (page URL), other extensions and missing senders', () => {
    expect(isOwnExtensionPage({ id: ID, url: 'https://app.example/checkout' }, ID, BASE)).toBe(false);
    expect(isOwnExtensionPage({ id: 'other', url: BASE + 'review.html' }, ID, BASE)).toBe(false);
    expect(isOwnExtensionPage({ id: ID }, ID, BASE)).toBe(false);
    expect(isOwnExtensionPage(undefined, ID, BASE)).toBe(false);
  });
  it('is not fooled by a look-alike extension origin', () => {
    expect(isOwnExtensionPage({ id: ID, url: `chrome-extension://${ID}.evil.example/x` }, ID, BASE)).toBe(false);
  });
});

describe('isOwnContentScript', () => {
  it('needs this extension id and a tab', () => {
    expect(isOwnContentScript({ id: ID, tab: { id: 4 } }, ID)).toBe(true);
    expect(isOwnContentScript({ id: ID }, ID)).toBe(false);
    expect(isOwnContentScript({ id: 'other', tab: { id: 4 } }, ID)).toBe(false);
  });
});

describe('isRememberableOrigin', () => {
  it('accepts plain http(s) origins incl. ports and localhost', () => {
    for (const o of ['https://app.example.com', 'http://localhost:5173', 'https://qa-1.staging.example.co.uk:8443', 'http://[::1]:3000']) expect(isRememberableOrigin(o)).toBe(true);
  });
  it('rejects wildcards, paths, credentials, schemes and junk', () => {
    for (const o of ['https://*.example.com', 'https://*', 'https://app.example.com/path', 'https://user:pw@app.example.com', 'file:///etc/passwd', 'chrome://settings', 'https://', 'app.example.com', '', 'https://a b.example', 'https://app.example.com?x=1', 42, null]) expect(isRememberableOrigin(o)).toBe(false);
  });
});
