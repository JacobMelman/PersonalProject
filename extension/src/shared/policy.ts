// Enterprise policy (Chrome managed storage). Everything here is pure so it can be unit-tested and reused by the policy generator.
// The admin sets values through the browser's own policy channel (GPO / Intune / MDM / JSON file); the extension never stores them as user data.
import type { Settings } from './types';

export type ExportFormat = 'zip' | 'html' | 'docx' | 'xlsx' | 'txt' | 'md';
export const EXPORT_FORMATS: ExportFormat[] = ['zip', 'html', 'docx', 'xlsx', 'txt', 'md'];

type LockableKey = 'replaySec' | 'tailSec' | 'preSessionSec' | 'afkMinutes' | 'markerScreenshot' | 'captureVideo' | 'environment';

export interface Policy {
  /** True when at least one policy value is present (shown to the user as "managed by your organization"). */
  managed: boolean;
  /** null = no restriction. A non-empty list is an allow-list of origin patterns where ReproDesk may be armed. */
  allowedTargetOrigins: string[] | null;
  /** Origin patterns where ReproDesk must never run (wins over the allow-list). */
  blockedOrigins: string[];
  /** Extra origins added to every user's approved semantic scope (plain origins). */
  approvedOrigins: string[];
  /** Capture settings the admin fixed; the user can no longer change them. */
  settings: Partial<Pick<Settings, LockableKey>>;
  /** null = every format. */
  allowedExportFormats: ExportFormat[] | null;
  allowUnredactedOriginals: boolean;
  requireExportConfirmation: boolean;
  /** 0 = keep until the user deletes. */
  sessionRetentionDays: number;
  sampleSessions: boolean;
}

export const NO_POLICY: Policy = {
  managed: false, allowedTargetOrigins: null, blockedOrigins: [], approvedOrigins: [], settings: {}, allowedExportFormats: null,
  allowUnredactedOriginals: true, requireExportConfirmation: false, sessionRetentionDays: 0, sampleSessions: true,
};

const MAX_LIST = 200;
const strings = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, MAX_LIST) : null;
const oneOf = <T extends number>(v: unknown, allowed: readonly T[]): T | undefined => (typeof v === 'number' && (allowed as readonly number[]).includes(v) ? (v as T) : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const PLAIN_ORIGIN = /^https?:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:]+\])(?::\d{1,5})?$/i;

/** Defensive parse of whatever managed storage returned (Chrome validates against the schema, but never trust a boundary). */
export function parsePolicy(raw: unknown): Policy {
  if (!raw || typeof raw !== 'object') return NO_POLICY;
  const r = raw as Record<string, unknown>;
  const settings: Policy['settings'] = {};
  const replay = oneOf(r.ReplayWindowSec, [30, 60, 90, 120] as const);
  if (replay !== undefined) settings.replaySec = replay;
  const tail = oneOf(r.PostTriggerTailSec, [0, 3, 5, 10] as const);
  if (tail !== undefined) settings.tailSec = tail;
  const pre = oneOf(r.PreSessionContextSec, [0, 30] as const);
  if (pre !== undefined) settings.preSessionSec = pre;
  const afk = oneOf(r.AfkAutoPauseMinutes, [0, 5, 10, 15, 30] as const);
  if (afk !== undefined) settings.afkMinutes = afk;
  const marker = bool(r.MarkerScreenshots);
  if (marker !== undefined) settings.markerScreenshot = marker;
  const video = bool(r.VideoCaptureAllowed);
  if (video === false) settings.captureVideo = false; // true only means "not forbidden": the user's own choice stays
  if (typeof r.EnvironmentLabel === 'string' && r.EnvironmentLabel.trim()) settings.environment = r.EnvironmentLabel.trim().slice(0, 60);

  const allowed = strings(r.AllowedTargetOrigins);
  const fmts = strings(r.AllowedExportFormats);
  const days = typeof r.SessionRetentionDays === 'number' && Number.isFinite(r.SessionRetentionDays) ? Math.min(3650, Math.max(0, Math.floor(r.SessionRetentionDays))) : 0;
  const p: Policy = {
    managed: false,
    allowedTargetOrigins: allowed && allowed.length ? allowed : null,
    blockedOrigins: strings(r.BlockedOrigins) ?? [],
    approvedOrigins: (strings(r.ApprovedOrigins) ?? []).filter((o) => PLAIN_ORIGIN.test(o)),
    settings,
    // An explicit list that names no known format means "none allowed" (fail closed), not "everything".
    allowedExportFormats: fmts ? EXPORT_FORMATS.filter((f) => fmts.map((x) => x.toLowerCase()).includes(f)) : null,
    allowUnredactedOriginals: bool(r.AllowUnredactedOriginals) ?? true,
    requireExportConfirmation: bool(r.RequireExportConfirmation) ?? false,
    sessionRetentionDays: days,
    sampleSessions: bool(r.SampleSessionsEnabled) ?? true,
  };
  p.managed = Object.keys(r).some((k) => r[k] !== undefined && r[k] !== null);
  return p;
}

const PATTERN = /^(\*|https?):\/\/(\*|\*\.[a-z0-9.-]+|[a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\*|\d{1,5}))?$/i;
const ORIGIN = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/i;

/**
 * Origin match pattern: `scheme://host[:port]`. scheme = http | https | *; host = exact | *.example.com (the domain and every subdomain) | *;
 * port = number | * . No port means the scheme's default port only (http 80, https 443), so `http://localhost` does NOT match localhost:5173 - write `http://localhost:*`.
 */
export function matchOrigin(pattern: string, origin: string): boolean {
  const p = PATTERN.exec(pattern.trim());
  const o = ORIGIN.exec(origin);
  if (!p || !o) return false;
  const [, ps, ph, pp] = p;
  const [, os, oh, op] = o;
  if (ps !== '*' && ps.toLowerCase() !== os.toLowerCase()) return false;
  const host = oh.toLowerCase();
  const pHost = ph.toLowerCase();
  if (pHost.startsWith('*.')) {
    const base = pHost.slice(2);
    if (!(host === base || host.endsWith('.' + base))) return false;
  } else if (pHost !== '*' && pHost !== host) return false;
  if (pp === '*') return true;
  const def = os.toLowerCase() === 'https' ? '443' : '80';
  return (op ?? def) === (pp ?? def);
}

export type TargetVerdict = { ok: true } | { ok: false; reason: 'blocked' | 'not-allowed'; message: string };

export function evaluateTarget(origin: string, policy: Policy): TargetVerdict {
  if (policy.blockedOrigins.some((p) => matchOrigin(p, origin))) {
    return { ok: false, reason: 'blocked', message: 'Your organization does not allow ReproDesk on this site.' };
  }
  if (policy.allowedTargetOrigins && !policy.allowedTargetOrigins.some((p) => matchOrigin(p, origin))) {
    return { ok: false, reason: 'not-allowed', message: 'Your organization allows ReproDesk only on approved sites, and this one is not on the list.' };
  }
  return { ok: true };
}

export const isOriginBlocked = (origin: string, policy: Policy): boolean => policy.blockedOrigins.some((p) => matchOrigin(p, origin));

/** The user's settings with the admin's values on top; approved origins are the union. */
export function applyPolicy(settings: Settings, policy: Policy): Settings {
  if (!policy.managed) return settings;
  return { ...settings, ...policy.settings, approvedOrigins: [...new Set([...settings.approvedOrigins, ...policy.approvedOrigins])] };
}

export const lockedKeys = (policy: Policy): Array<keyof Settings> => Object.keys(policy.settings) as Array<keyof Settings>;

/** Drops locked keys from a patch so a user (or a bug) can never persist a value the admin has fixed. */
export function stripLocked(patch: Partial<Settings>, policy: Policy): Partial<Settings> {
  const out = { ...patch };
  for (const k of lockedKeys(policy)) delete out[k];
  return out;
}

export const allowedFormats = (policy: Policy): ExportFormat[] => policy.allowedExportFormats ?? EXPORT_FORMATS;

/** Finished sessions older than the retention window. Active sessions are never selected. */
export function selectExpired<T extends { id: string; status: string; createdAt: number; endedAt: number | null }>(sessions: T[], now: number, days: number): T[] {
  if (days <= 0) return [];
  const cutoff = now - days * 86_400_000;
  return sessions.filter((s) => s.status !== 'active' && (s.endedAt ?? s.createdAt) < cutoff);
}

/** Validation for tooling (policy generator): a list of human-readable problems with a raw policy object. */
export function validateRawPolicy(raw: unknown): string[] {
  const errs: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['policy must be a JSON object'];
  const r = raw as Record<string, unknown>;
  const known = ['AllowedTargetOrigins', 'BlockedOrigins', 'ApprovedOrigins', 'ReplayWindowSec', 'PostTriggerTailSec', 'PreSessionContextSec', 'AfkAutoPauseMinutes', 'MarkerScreenshots',
    'VideoCaptureAllowed', 'EnvironmentLabel', 'AllowedExportFormats', 'AllowUnredactedOriginals', 'RequireExportConfirmation', 'SessionRetentionDays', 'SampleSessionsEnabled'];
  for (const k of Object.keys(r)) if (!known.includes(k)) errs.push(`unknown policy "${k}"`);
  const list = (k: string, check: (s: string) => string | null) => {
    if (r[k] === undefined) return;
    if (!Array.isArray(r[k]) || (r[k] as unknown[]).some((x) => typeof x !== 'string')) return void errs.push(`${k} must be an array of strings`);
    for (const s of r[k] as string[]) { const e = check(s); if (e) errs.push(`${k}: ${e}`); }
  };
  const pat = (s: string) => (PATTERN.test(s.trim()) ? null : `"${s}" is not a valid origin pattern (scheme://host[:port], e.g. https://*.example.com or http://localhost:*)`);
  list('AllowedTargetOrigins', pat);
  list('BlockedOrigins', pat);
  list('ApprovedOrigins', (s) => (PLAIN_ORIGIN.test(s) ? null : `"${s}" must be a plain origin such as https://sso.example.com`));
  list('AllowedExportFormats', (s) => (EXPORT_FORMATS.includes(s.toLowerCase() as ExportFormat) ? null : `"${s}" is not one of ${EXPORT_FORMATS.join(', ')}`));
  const num = (k: string, allowed?: number[], min?: number, max?: number) => {
    if (r[k] === undefined) return;
    const v = r[k];
    if (typeof v !== 'number' || !Number.isInteger(v)) return void errs.push(`${k} must be an integer`);
    if (allowed && !allowed.includes(v)) errs.push(`${k} must be one of ${allowed.join(', ')}`);
    if (min !== undefined && v < min) errs.push(`${k} must be >= ${min}`);
    if (max !== undefined && v > max) errs.push(`${k} must be <= ${max}`);
  };
  num('ReplayWindowSec', [30, 60, 90, 120]);
  num('PostTriggerTailSec', [0, 3, 5, 10]);
  num('PreSessionContextSec', [0, 30]);
  num('AfkAutoPauseMinutes', [0, 5, 10, 15, 30]);
  num('SessionRetentionDays', undefined, 0, 3650);
  for (const k of ['MarkerScreenshots', 'VideoCaptureAllowed', 'AllowUnredactedOriginals', 'RequireExportConfirmation', 'SampleSessionsEnabled']) {
    if (r[k] !== undefined && typeof r[k] !== 'boolean') errs.push(`${k} must be true or false`);
  }
  if (r.EnvironmentLabel !== undefined && typeof r.EnvironmentLabel !== 'string') errs.push('EnvironmentLabel must be a string');
  return errs;
}
