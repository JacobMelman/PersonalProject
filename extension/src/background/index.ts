import {
  addMarker, armFromTab, deleteSession, disarm, dispatch, finishRepro, finishShotSession, getState, injectContent, notify, onIdleState,
  onOffscreenEvent, onPort, onTabRemoved, onTabUpdated, openReview, recover, refreshBadge, reevaluate, resumeFromAfk, saveReplay,
  serial, startRepro, takeScreenshot, tick,
} from './core';
import type { CommandMessage, OffscreenEvent } from '../shared/messages';
import { getSettings } from '../shared/settings';
import { minimizeUrl } from '../shared/privacy';
import type { Settings } from '../shared/types';

// User invocation of the extension (toolbar icon) is what grants activeTab, which tabCapture requires.
// sidePanel.open must be called synchronously inside the gesture, before any await.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null) void chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
  void serial(() => armFromTab(tab));
});

chrome.runtime.onConnect.addListener(onPort);
chrome.tabs.onRemoved.addListener((tabId) => void serial(() => onTabRemoved(tabId)));
chrome.tabs.onUpdated.addListener((tabId, info) => void serial(() => onTabUpdated(tabId, info)));
chrome.tabs.onActivated.addListener(() => void serial(reevaluate));
chrome.windows.onRemoved.addListener(() => void serial(reevaluate));
chrome.idle.onStateChanged.addListener((st) => void serial(() => onIdleState(st)));
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'tick') void serial(tick);
});

chrome.commands.onCommand.addListener((command) => {
  void serial(async () => {
    const s = await getState();
    if (command === 'save-last-replay') await saveReplay();
    else if (command === 'add-marker') await addMarker();
    else if (command === 'take-screenshot') await takeScreenshot();
    else if (command === 'toggle-repro') {
      if (s.sessionId) await (s.mode === 'repro' ? finishRepro() : finishShotSession());
      else await startRepro();
    }
  });
});

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as { kind?: string };
  if (m?.kind === 'cmd') {
    const c = msg as CommandMessage;
    void serial(async () => {
      switch (c.cmd) {
        case 'saveReplay': return saveReplay();
        case 'startRepro': return startRepro(!!c.payload?.afkOverride);
        case 'finishRepro': return (await getState()).mode === 'repro' ? finishRepro() : finishShotSession();
        case 'finishShotSession': return finishShotSession();
        case 'marker': return addMarker(c.payload?.label as string | undefined);
        case 'screenshot': return takeScreenshot();
        case 'manualPause': await dispatch({ type: 'MANUAL_PAUSE' }); return;
        case 'manualResume': await dispatch({ type: 'MANUAL_RESUME' }); await reevaluate(); return;
        case 'resumeFromAfk': return resumeFromAfk();
        case 'disarm': return disarm();
        case 'ackTerminal': await dispatch({ type: 'DISARM' }); return;
        case 'openReview': return openReview(String(c.payload?.sessionId));
        case 'siteRemembered': return registerRememberedSite(String(c.payload?.origin));
      }
    }).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (m?.kind === 'off-event') {
    void serial(() => onOffscreenEvent(msg as OffscreenEvent));
    return false;
  }
  if (m?.kind === 'delete-session') {
    void serial(() => deleteSession(String((msg as { id: string }).id))).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

/** "Remember this site": persistent content-script registration for an origin the user granted host access to. */
async function registerRememberedSite(origin: string): Promise<void> {
  const id = 'rd-' + origin.replace(/[^a-z0-9]/gi, '_');
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (!existing.length) {
    await chrome.scripting.registerContentScripts([{ id, matches: [`${origin}/*`], js: ['content.js'], runAt: 'document_start', allFrames: true, persistAcrossSessions: true }]);
  }
  const s = await getSettings();
  if (!s.approvedOrigins.includes(origin)) await chrome.storage.local.set({ settings: { ...s, approvedOrigins: [...s.approvedOrigins, origin] } });
  const st = await getState();
  if (st.targetTabId != null) await injectContent(st.targetTabId);
  await notify(`Site remembered: ${origin}`, 'info');
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const next = changes.settings.newValue as Settings;
  void serial(async () => {
    const s = await getState();
    if (s.mode === 'inactive') return;
    await chrome.idle.setDetectionInterval(Math.max(15, (next.afkMinutes || 10) * 60));
    await chrome.runtime.sendMessage({ kind: 'off', op: 'config', settings: next }).catch(() => undefined);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
  void navigator.storage.persist?.();
  void serial(recover);
});
chrome.runtime.onStartup.addListener(() => void serial(recover));
void serial(async () => {
  await recover();
  await refreshBadge();
});

const BOOT = Date.now();
// Diagnostics: how many times Chrome has (re)started this service worker in the current browser session.
void chrome.storage.session.get('swStarts').then((r) => chrome.storage.session.set({ swStarts: ((r.swStarts as number) ?? 0) + 1, swLastStart: BOOT }));
if (__E2E__) {
  // Test hook used by Playwright only (never present in the release build).
  (self as unknown as { __rd: unknown }).__rd = {
    armTab: async (tabId: number) => serial(async () => armFromTab(await chrome.tabs.get(tabId))),
    boot: BOOT,
    state: () => getState(),
    saveReplay: () => serial(saveReplay),
    startRepro: () => serial(() => startRepro()),
    finishRepro: () => serial(finishRepro),
    marker: (l?: string) => serial(() => addMarker(l)),
    screenshot: () => serial(() => takeScreenshot()),
    disarm: () => serial(disarm),
    dispatch: (e: Parameters<typeof dispatch>[0]) => serial(() => dispatch(e)),
    reevaluate: () => serial(reevaluate),
    minimizeUrl,
  };
}
