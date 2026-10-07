import { DEFAULT_SETTINGS, type Settings } from './types';

export async function getSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) } as Settings;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
