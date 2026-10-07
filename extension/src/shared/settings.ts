import { DEFAULT_SETTINGS, type Settings } from './types';
import { NO_POLICY, applyPolicy, parsePolicy, stripLocked, type Policy } from './policy';

/**
 * The administrator's policy from Chrome managed storage (GPO / Intune / MDM / JSON file). Missing, unreadable or empty means "no policy".
 * E2E builds additionally read `__policy` from local storage so the enforcement can be tested without a real enterprise policy channel
 * (the release build contains no such branch; the real channel is covered by the real-browser suite).
 */
export async function getPolicy(): Promise<Policy> {
  try {
    if (__E2E__) {
      const t = await chrome.storage.local.get('__policy');
      if (t.__policy) return parsePolicy(t.__policy);
    }
    return parsePolicy(await chrome.storage.managed.get(null));
  } catch {
    return NO_POLICY; // no managed storage for this profile
  }
}

/** Settings as they really apply: the user's own values with the administrator's policy on top. */
export async function getSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get('settings');
  const own = { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) } as Settings;
  return applyPolicy(own, await getPolicy());
}

/** Persists the user's choices; keys the administrator fixed are dropped, and policy-added origins are never copied into local storage. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const policy = await getPolicy();
  const r = await chrome.storage.local.get('settings');
  const own = { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) } as Settings;
  const clean = stripLocked(patch, policy);
  if (clean.approvedOrigins) clean.approvedOrigins = clean.approvedOrigins.filter((o) => !policy.approvedOrigins.includes(o));
  await chrome.storage.local.set({ settings: { ...own, ...clean } });
  return getSettings();
}

/** Calls back when the administrator changes the policy while the browser is running. */
export function onPolicyChanged(cb: () => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'managed' || (__E2E__ && area === 'local' && '__policy' in changes)) cb();
  });
}
