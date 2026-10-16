import { describe, expect, it } from 'vitest';
import {
  buildHar, cleanMessage, droppedInBatch, cleanRequestUrl, cleanStack, consoleText, isConsoleProblem, isNetProblem, LOG_LIMITS, LogBudget, netText, redactText, sanitizeRaw, stripUrlQueries,
} from '../../src/shared/devlog';

const NOW = 1_800_000_000_000;
const PAGE = 'https://shop.example/checkout?step=2';

describe('redactText', () => {
  it('redacts emails, JWTs, auth headers and secret key/value pairs', () => {
    expect(redactText('user jane.doe@bank.example signed in')).toBe('user [email] signed in');
    expect(redactText('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe('token [jwt]');
    expect(redactText('Authorization: Bearer abc.def-123_456')).toBe('Authorization: [redacted]');
    expect(redactText('sent with Bearer abc.def-123_456')).toBe('sent with Bearer [token]');
    expect(redactText('{"user":"jane","password":"hunter2","otp":"123456"}')).toBe('{"user":"jane","password":"[redacted]","otp":"[redacted]"}');
    expect(redactText('login password=hunter2&next=/home')).toBe('login password=[redacted]&next=/home');
    expect(redactText('x_auth_token: abc123 spinner=3 author: Jane pin: 4321')).toBe('x_auth_token: [redacted] spinner=3 author: Jane pin: [redacted]');
  });

  it('redacts card numbers only when the Luhn check passes, and leaves timestamps, ids and line numbers alone', () => {
    expect(redactText('card 4111 1111 1111 1111 declined')).toBe('card [card] declined');
    expect(redactText('card 4111-1111-1111-1111')).toBe('card [card]');
    expect(redactText('order 4111111111111112 failed')).toBe('order 4111111111111112 failed'); // not Luhn-valid
    expect(redactText('at 1800000000000 ms, order #48213, app.js:1234:56')).toBe('at 1800000000000 ms, order #48213, app.js:1234:56');
  });

  it('redacts long mixed tokens but keeps bundle hashes inside file names and paths readable', () => {
    expect(redactText('key zq7_Rk2Lw9Xc4Vb8Nm1Pt6Yh3Gf5Dj0Sa2Ue used')).toBe('key [secret] used');
    expect(redactText('at main.4f3a2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e.js:10:5')).toBe('at main.4f3a2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e.js:10:5');
    expect(redactText('/static/js/4f3a2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e/app.js')).toBe('/static/js/4f3a2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e/app.js');
  });
});

describe('URLs', () => {
  it('keeps origin, path and parameter names; drops query values and the fragment', () => {
    expect(cleanRequestUrl('/api/search?q=jane%40bank.example&page=2#top', PAGE)).toBe('https://shop.example/api/search?q=…&page=…');
    expect(cleanRequestUrl('https://api.example/v1/orders')).toBe('https://api.example/v1/orders');
  });
  it('masks id- and token-looking path segments and redacts emails in paths', () => {
    expect(cleanRequestUrl('https://api.example/users/3f2b8c1e-1d2a-4b5c-9e8f-0a1b2c3d4e5f/reset/a1b2c3d4e5f6a7b8c9d0e1f2a3')).toBe('https://api.example/users/:id/reset/:token');
    expect(cleanRequestUrl('https://api.example/users/jane.doe@bank.example/profile')).toBe('https://api.example/users/[email]/profile');
    expect(cleanRequestUrl('https://cdn.example/js/main.4f3a2b1c9d8e7f6a5b4c3d2e.js')).toBe('https://cdn.example/js/main.4f3a2b1c9d8e7f6a5b4c3d2e.js');
  });
  it('keeps only the scheme of data:, blob: and other URLs, and survives garbage', () => {
    expect(cleanRequestUrl('data:image/png;base64,AAAA')).toBe('data:…');
    expect(cleanRequestUrl('blob:https://shop.example/1234')).toBe('blob:…');
    expect(cleanRequestUrl('http://[bad')).toBe('(invalid URL)');
  });
  it('strips queries from URLs inside text but keeps :line:column', () => {
    expect(stripUrlQueries('at f (https://app.example/x.js?v=3&t=secret:10:5)')).toBe('at f (https://app.example/x.js:10:5)');
    expect(stripUrlQueries('GET https://api.example/u?email=a@b.example#x failed')).toBe('GET https://api.example/u failed');
  });
});

describe('sanitizeRaw', () => {
  const c = (extra: object) => sanitizeRaw({ k: 'c', ts: NOW - 100, level: 'error', args: ['x'], ...extra }, PAGE, NOW, NOW - 10_000);
  it('turns a console call into a bounded, redacted entry', () => {
    const r = c({ args: ['Payment failed for', 'jane@bank.example', { code: 'E-4021', token: 'abc' }], stack: 'TypeError: x\n    at pay (https://shop.example/app.js?v=9:12:3)\n    at onClick (https://shop.example/app.js:40:1)' });
    expect(r).toEqual({ ts: NOW - 100, console: { level: 'error', source: 'console', text: 'Payment failed for [email] {"code":"E-4021","token":"[redacted]"}', stack: 'at pay (https://shop.example/app.js:12:3)\nat onClick (https://shop.example/app.js:40:1)' } });
    expect(c({ level: 'log' })).toMatchObject({ console: { level: 'info' } });
    expect(c({ level: 'nonsense' })).toBeNull();
    expect(c({ source: 'exception' })).toMatchObject({ console: { source: 'exception' } });
    const long = c({ args: ['a'.repeat(5000)] });
    expect(long && 'console' in long && long.console.text.length).toBe(LOG_LIMITS.text);
  });
  it('drops entries from before capture began, from too long ago, or from the future', () => {
    expect(c({ ts: NOW - 20_000 })).toBeNull();
    expect(sanitizeRaw({ k: 'c', ts: NOW - 70_000, level: 'error', args: ['x'] }, PAGE, NOW, 0)).toBeNull();
    expect(c({ ts: NOW + 60_000 })).toBeNull();
    expect(c({ ts: 'soon' })).toBeNull();
  });
  it('turns a request into metadata only', () => {
    const r = sanitizeRaw({ k: 'n', ts: NOW - 50, kind: 'fetch', method: 'post', url: '/api/orders?card=4111111111111111', status: 500, ms: 123.6, size: 42, body: 'never', headers: { cookie: 'x' } }, PAGE, NOW, 0);
    expect(r).toEqual({ ts: NOW - 50, net: { kind: 'fetch', method: 'POST', url: 'https://shop.example/api/orders?card=…', status: 500, ms: 124, size: 42 } });
    expect(sanitizeRaw({ k: 'n', ts: NOW, kind: 'xhr', method: 'GET', url: '/a', status: 0, error: 'failed' }, PAGE, NOW, 0)).toMatchObject({ net: { status: 0, error: 'failed' } });
    expect(sanitizeRaw({ k: 'n', ts: NOW, kind: 'weird', method: 'DROP TABLE', url: '/a', error: 'whatever', initiator: '<img>' }, PAGE, NOW, 0)).toEqual({ ts: NOW, net: { kind: 'resource', method: '', url: 'https://shop.example/a', status: 0, ms: 0 } });
    expect(sanitizeRaw({ k: 'n', ts: NOW, url: 42 }, PAGE, NOW, 0)).toBeNull();
    expect(sanitizeRaw(null, PAGE, NOW, 0)).toBeNull();
  });
});

describe('reading the log', () => {
  it('classifies problems and formats rows', () => {
    expect(isConsoleProblem({ level: 'error', source: 'console', text: 'x' })).toBe(true);
    expect(isConsoleProblem({ level: 'warn', source: 'console', text: 'x' })).toBe(false);
    expect(isConsoleProblem({ level: 'info', source: 'rejection', text: 'x' })).toBe(true);
    expect(isNetProblem({ kind: 'fetch', method: 'GET', url: 'u', status: 404, ms: 1 })).toBe(true);
    expect(isNetProblem({ kind: 'resource', method: '', url: 'u', status: 0, ms: 1 })).toBe(false); // unknown, not failed
    expect(isNetProblem({ kind: 'xhr', method: 'GET', url: 'u', status: 0, ms: 1, error: 'timeout' })).toBe(true);
    expect(consoleText({ level: 'error', source: 'exception', text: 'TypeError: x is undefined' })).toBe('Uncaught TypeError: x is undefined');
    expect(netText({ kind: 'fetch', method: 'POST', url: 'https://a.example/api', status: 500, ms: 120 })).toBe('POST https://a.example/api → 500 (120 ms)');
    expect(netText({ kind: 'resource', method: '', url: 'https://a.example/x.png', status: 0, ms: 0 })).toBe('https://a.example/x.png → —');
  });
  it('cleanMessage and cleanStack cope with odd input', () => {
    expect(cleanMessage([undefined, null, 3, 'a\u0007b'])).toBe('undefined null 3 a b');
    expect(cleanMessage('nope' as unknown as unknown[])).toBe('');
    expect(cleanStack('no frames here')).toBeUndefined();
    expect(cleanStack(Array.from({ length: 30 }, (_, i) => `    at f${i} (https://a.example/x.js:${i}:1)`).join('\n'))?.split('\n')).toHaveLength(LOG_LIMITS.stackLines);
  });
});

describe('LogBudget', () => {
  it('lets a minute hold at most the budget and counts what it dropped', () => {
    const b = new LogBudget(100);
    expect(b.take(60, NOW)).toBe(60);
    expect(b.take(60, NOW + 1000)).toBe(40);
    expect(b.take(10, NOW + 2000)).toBe(0);
    expect(b.dropped).toBe(30);
    expect(b.take(10, NOW + 61_000)).toBe(10);
  });
  it('reads what the page recorder says it discarded, bounded', () => {
    expect(droppedInBatch([{ k: 'c' }, { k: 'drop', n: 12 }, { k: 'drop', n: -5 }, { k: 'drop', n: 'x' }, null])).toBe(12);
    expect(droppedInBatch([{ k: 'drop', n: 1e12 }])).toBe(1e6);
  });
});

describe('buildHar', () => {
  it('is a HAR 1.2 log with request metadata only', () => {
    const har = buildHar(
      [
        { ts: NOW + 20, net: { kind: 'xhr', method: 'GET', url: 'https://a.example/x?q=…', status: 0, ms: 5, error: 'failed' } },
        { ts: NOW, net: { kind: 'resource', method: '', url: 'https://a.example/app.js', status: 200, ms: 30, size: 1200, initiator: 'script' } },
      ],
      '0.0.1', 'Bug', NOW,
    ) as { log: { version: string; entries: Array<Record<string, any>> } };
    expect(har.log.version).toBe('1.2');
    expect(har.log.entries.map((e) => e.request.url)).toEqual(['https://a.example/app.js', 'https://a.example/x?q=…']);
    expect(har.log.entries[0]).toMatchObject({ request: { method: 'GET', headers: [], cookies: [] }, response: { status: 200, content: { size: 1200 } }, _resourceType: 'script' });
    expect(har.log.entries[1]).toMatchObject({ request: { queryString: [{ name: 'q', value: '…' }] }, response: { status: 0, statusText: 'failed' }, _error: 'failed', _resourceType: 'xhr' });
    expect(JSON.stringify(har)).not.toMatch(/postData|"text"/);
  });
});
