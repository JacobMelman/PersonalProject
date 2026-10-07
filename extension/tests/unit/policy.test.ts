import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import { NO_POLICY, allowedFormats, applyPolicy, evaluateTarget, lockedKeys, matchOrigin, parsePolicy, selectExpired, stripLocked, validateRawPolicy } from '../../src/shared/policy';

describe('parsePolicy', () => {
  it('returns the neutral policy for nothing / junk', () => {
    expect(parsePolicy(undefined)).toBe(NO_POLICY);
    expect(parsePolicy('x')).toBe(NO_POLICY);
    expect(parsePolicy({}).managed).toBe(false);
  });
  it('reads every policy and marks the browser as managed', () => {
    const p = parsePolicy({
      AllowedTargetOrigins: ['https://*.corp.example'], BlockedOrigins: ['https://hr.corp.example'], ApprovedOrigins: ['https://sso.corp.example', 'not an origin', 'https://x.example/path'],
      ReplayWindowSec: 60, PostTriggerTailSec: 3, PreSessionContextSec: 0, AfkAutoPauseMinutes: 5, MarkerScreenshots: false, VideoCaptureAllowed: false, EnvironmentLabel: ' QA staging ',
      AllowedExportFormats: ['HTML', 'zip', 'pdf'], AllowUnredactedOriginals: false, RequireExportConfirmation: true, SessionRetentionDays: 30, SampleSessionsEnabled: false,
    });
    expect(p.managed).toBe(true);
    expect(p.allowedTargetOrigins).toEqual(['https://*.corp.example']);
    expect(p.approvedOrigins).toEqual(['https://sso.corp.example']);
    expect(p.settings).toEqual({ replaySec: 60, tailSec: 3, preSessionSec: 0, afkMinutes: 5, markerScreenshot: false, captureVideo: false, environment: 'QA staging' });
    expect(p.allowedExportFormats).toEqual(['zip', 'html']);
    expect(p.allowUnredactedOriginals).toBe(false);
    expect(p.requireExportConfirmation).toBe(true);
    expect(p.sessionRetentionDays).toBe(30);
    expect(p.sampleSessions).toBe(false);
  });
  it('ignores out-of-range values instead of guessing', () => {
    const p = parsePolicy({ ReplayWindowSec: 45, PostTriggerTailSec: 'x', SessionRetentionDays: -5, AfkAutoPauseMinutes: 7 });
    expect(p.settings).toEqual({});
    expect(p.sessionRetentionDays).toBe(0);
  });
  it('VideoCaptureAllowed=true does not force video on', () => {
    expect(parsePolicy({ VideoCaptureAllowed: true }).settings).toEqual({});
  });
  it('an export list with no known format means none allowed (fail closed)', () => {
    expect(parsePolicy({ AllowedExportFormats: ['pdf'] }).allowedExportFormats).toEqual([]);
    expect(allowedFormats(parsePolicy({ AllowedExportFormats: ['pdf'] }))).toEqual([]);
    expect(allowedFormats(NO_POLICY)).toHaveLength(6);
  });
  it('an empty allow-list means no restriction', () => {
    expect(parsePolicy({ AllowedTargetOrigins: [] }).allowedTargetOrigins).toBeNull();
  });
});

describe('matchOrigin', () => {
  it('matches exact origins and default ports', () => {
    expect(matchOrigin('https://app.corp.example', 'https://app.corp.example')).toBe(true);
    expect(matchOrigin('https://app.corp.example', 'https://app.corp.example:443')).toBe(true);
    expect(matchOrigin('https://app.corp.example', 'https://app.corp.example:8443')).toBe(false);
    expect(matchOrigin('https://app.corp.example', 'http://app.corp.example')).toBe(false);
  });
  it('wildcard subdomain covers the domain and any depth, but not look-alikes', () => {
    expect(matchOrigin('https://*.corp.example', 'https://a.corp.example')).toBe(true);
    expect(matchOrigin('https://*.corp.example', 'https://a.b.corp.example')).toBe(true);
    expect(matchOrigin('https://*.corp.example', 'https://corp.example')).toBe(true);
    expect(matchOrigin('https://*.corp.example', 'https://evilcorp.example')).toBe(false);
    expect(matchOrigin('https://*.corp.example', 'https://corp.example.evil.test')).toBe(false);
  });
  it('ports: none = default only, * = any', () => {
    expect(matchOrigin('http://localhost', 'http://localhost:5173')).toBe(false);
    expect(matchOrigin('http://localhost:*', 'http://localhost:5173')).toBe(true);
    expect(matchOrigin('http://localhost:5173', 'http://localhost:5173')).toBe(true);
    expect(matchOrigin('http://localhost:5173', 'http://localhost:5174')).toBe(false);
  });
  it('scheme wildcard and case-insensitivity', () => {
    expect(matchOrigin('*://*.corp.example', 'http://a.corp.example')).toBe(true);
    expect(matchOrigin('HTTPS://APP.Corp.Example', 'https://app.corp.example')).toBe(true);
  });
  it('malformed patterns never match', () => {
    for (const p of ['', 'app.corp.example', 'https://', 'https://app.corp.example/path', 'ftp://x', 'https://a b']) expect(matchOrigin(p, 'https://app.corp.example')).toBe(false);
  });
});

describe('evaluateTarget', () => {
  const pol = parsePolicy({ AllowedTargetOrigins: ['https://*.corp.example', 'http://localhost:*'], BlockedOrigins: ['https://hr.corp.example'] });
  it('allows listed sites', () => {
    expect(evaluateTarget('https://qa.corp.example', pol).ok).toBe(true);
    expect(evaluateTarget('http://localhost:5173', pol).ok).toBe(true);
  });
  it('refuses unlisted sites', () => {
    const v = evaluateTarget('https://news.example', pol);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('not-allowed');
  });
  it('blocked wins over the allow-list', () => {
    const v = evaluateTarget('https://hr.corp.example', pol);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('blocked');
  });
  it('no policy = everything allowed', () => {
    expect(evaluateTarget('https://anything.example', NO_POLICY).ok).toBe(true);
  });
  it('an allow-list with only invalid patterns allows nothing (fail closed)', () => {
    expect(evaluateTarget('https://qa.corp.example', parsePolicy({ AllowedTargetOrigins: ['corp.example'] })).ok).toBe(false);
  });
});

describe('applyPolicy / stripLocked', () => {
  const pol = parsePolicy({ ReplayWindowSec: 30, ApprovedOrigins: ['https://sso.corp.example'], VideoCaptureAllowed: false });
  it('admin values override and origins are unioned', () => {
    const s = applyPolicy({ ...DEFAULT_SETTINGS, replaySec: 120, approvedOrigins: ['https://a.example'] }, pol);
    expect(s.replaySec).toBe(30);
    expect(s.captureVideo).toBe(false);
    expect(s.approvedOrigins).toEqual(['https://a.example', 'https://sso.corp.example']);
    expect(s.tailSec).toBe(DEFAULT_SETTINGS.tailSec);
  });
  it('untouched without a policy', () => {
    expect(applyPolicy(DEFAULT_SETTINGS, NO_POLICY)).toBe(DEFAULT_SETTINGS);
  });
  it('locked keys cannot be persisted', () => {
    expect(lockedKeys(pol).sort()).toEqual(['captureVideo', 'replaySec']);
    expect(stripLocked({ replaySec: 120, tailSec: 5, captureVideo: true }, pol)).toEqual({ tailSec: 5 });
  });
});

describe('selectExpired', () => {
  const DAY = 86_400_000;
  const now = 100 * DAY;
  const s = (id: string, status: string, ageDays: number) => ({ id, status, createdAt: now - ageDays * DAY - 1000, endedAt: now - ageDays * DAY });
  it('selects finished sessions older than the window and never active ones', () => {
    const list = [s('old', 'finished', 40), s('new', 'finished', 5), s('live', 'active', 90), s('rec', 'recovered', 31)];
    expect(selectExpired(list, now, 30).map((x) => x.id)).toEqual(['old', 'rec']);
  });
  it('0 days = keep everything', () => {
    expect(selectExpired([s('old', 'finished', 400)], now, 0)).toEqual([]);
  });
  it('falls back to createdAt when a session never ended', () => {
    expect(selectExpired([{ id: 'x', status: 'finished', createdAt: now - 40 * DAY, endedAt: null }], now, 30)).toHaveLength(1);
  });
});

describe('validateRawPolicy', () => {
  it('accepts a good policy', () => {
    expect(validateRawPolicy({ AllowedTargetOrigins: ['https://*.corp.example'], ReplayWindowSec: 60, AllowedExportFormats: ['zip', 'html'], RequireExportConfirmation: true })).toEqual([]);
  });
  it('lists every problem in plain words', () => {
    const e = validateRawPolicy({ AllowedTargetOrigins: ['corp.example'], ReplayWindowSec: 45, AllowedExportFormats: ['pdf'], SessionRetentionDays: -1, Foo: 1, MarkerScreenshots: 'yes' });
    expect(e.length).toBe(6);
    expect(e.join(' ')).toMatch(/not a valid origin pattern/);
    expect(e.join(' ')).toMatch(/unknown policy "Foo"/);
  });
});
