import { describe, expect, it } from 'vitest';
import { REDACTED, implicitRole, isEditableKind, minimizeUrl, sanitizeLabel, sanitizeStableId } from '../../src/shared/privacy';

describe('sanitizeLabel', () => {
  it('keeps ordinary UI labels', () => {
    expect(sanitizeLabel('  Add to   cart ')).toBe('Add to cart');
  });
  it('redacts emails, phones, card numbers, jwt and long tokens', () => {
    expect(sanitizeLabel('Welcome jane.doe@bank.example')).toBe(`Welcome ${REDACTED}`);
    expect(sanitizeLabel('Call +1 (415) 555-0199 now')).toContain(REDACTED);
    expect(sanitizeLabel('Card 4111 1111 1111 1111')).toBe(`Card ${REDACTED}`);
    expect(sanitizeLabel('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij')).toBe(`token ${REDACTED}`);
    // synthetic token built at runtime so secret scanners do not mistake the fixture for a real credential
    const fake = ['Ab12', 'Cd34', 'Ef56', 'Gh78', 'Ij90', 'Kl12'].join('');
    expect(sanitizeLabel(`key ${fake}`)).toBe(`key ${REDACTED}`);
  });
  it('truncates long labels and returns null for empty', () => {
    expect(sanitizeLabel('a'.repeat(200))!.length).toBeLessThanOrEqual(80);
    expect(sanitizeLabel('   ')).toBeNull();
    expect(sanitizeLabel(null)).toBeNull();
  });
});

describe('sanitizeStableId', () => {
  it('accepts name-like ids and rejects uuid / numeric ids', () => {
    expect(sanitizeStableId('btnSave')).toBe('btnSave');
    expect(sanitizeStableId('add-to-cart')).toBe('add-to-cart');
    expect(sanitizeStableId('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBeNull();
    expect(sanitizeStableId('user12345678')).toBeNull();
    expect(sanitizeStableId('1abc')).toBeNull();
  });
});

describe('minimizeUrl', () => {
  it('drops query and fragment', () => {
    expect(minimizeUrl('https://qa.example/customer/42?token=abc#frag')).toEqual({ origin: 'https://qa.example', path: '/customer/42' });
  });
  it('masks uuid and token-like path segments', () => {
    expect(minimizeUrl('https://qa.example/o/3f2504e0-4f89-11d3-9a0c-0305e82c3301/x')!.path).toBe('/o/:id/x');
    expect(minimizeUrl('https://qa.example/r/abcDEF1234567890abcDEF123/x')!.path).toBe('/r/:token/x');
  });
  it('rejects non-http(s) and garbage', () => {
    expect(minimizeUrl('chrome://settings')).toBeNull();
    expect(minimizeUrl('not a url')).toBeNull();
    expect(minimizeUrl(undefined)).toBeNull();
  });
});

describe('element kinds', () => {
  it('flags editable controls', () => {
    expect(isEditableKind('input', 'password', false)).toBe(true);
    expect(isEditableKind('input', null, false)).toBe(true);
    expect(isEditableKind('textarea', null, false)).toBe(true);
    expect(isEditableKind('div', null, true)).toBe(true);
    expect(isEditableKind('input', 'submit', false)).toBe(false);
    expect(isEditableKind('button', null, false)).toBe(false);
  });
  it('derives implicit roles', () => {
    expect(implicitRole('button', null)).toBe('button');
    expect(implicitRole('input', 'checkbox')).toBe('checkbox');
    expect(implicitRole('a', null)).toBe('link');
  });
});
