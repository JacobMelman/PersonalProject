// Service-worker core. Every entry point (command, port message, tab event, alarm) runs through serial() so that
// state transitions never interleave; the authoritative state lives in chrome.storage.session, never in globals.
import { collecting, collectingSemantics, displayState, initialState, reduce, type StateEvent } from '../shared/state';
import { getPolicy, getSettings } from '../shared/settings';
import { evaluateTarget, isOriginBlocked, selectExpired } from '../shared/policy';
import { isApprovedOrigin, minimizeUrl } from '../shared/privacy';
import { FRAME_PORT_NAME, PORT_NAME, type ContentMessage, type OffscreenEvent, type OffscreenOp, type PinResult } from '../shared/messages';
import type { CaptureState, HealthSnapshot, ScreenshotItem, SessionKind, SessionRecord, Settings, TimelineEvent } from '../shared/types';
import { dbAdd, dbDelete, dbDeleteWhereSession, dbGet, dbGetAll, dbIndexAll, dbPut, eventsOfSession, deleteEventsRange } from '../storage/db';
import { opfsRemove, opfsWrite } from '../storage/opfs';
import { cleanupRing, segmentsOfSession, unpinSession } from '../storage/segments';
import { isOwnContentScript } from '../shared/trust';

const STATE_KEY = 'state';
const RECOVERED_RETENTION_MS = 7 * 24 * 3600 * 1000;

export const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------------------------------------------------------------- serialisation + state persistence
let chain: Promise<unknown> = Promise.resolve();
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

export async function getState(): Promise<CaptureState> {
  const r = await chrome.storage.session.get(STATE_KEY);
  return (r[STATE_KEY] as CaptureState | undefined) ?? initialState();
}
async function saveState(s: CaptureState): Promise<void> {
  await chrome.storage.session.set({ [STATE_KEY]: s });
}

export async function notify(text: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
  await chrome.storage.session.set({ notice: { text, level, at: Date.now() } });
}

// ---------------------------------------------------------------- content ports (memory only, rebuilt by content-script hellos)
interface PortInfo {
  port: chrome.runtime.Port;
  origin: string | null;
  helloAt: number;
  /** Last sign of life (hello / ping / event). A document frozen in bfcache stops pinging. */
  seenAt: number;
}
const LIVENESS_MS = 3500;
const ports = new Map<number, PortInfo>();

export const browserName = (): string => {
  const m = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
  const edge = /Edg\/([\d.]+)/.exec(navigator.userAgent);
  return edge ? `Edge ${edge[1]}` : m ? `Chrome ${m[1]}` : navigator.userAgent;
};

async function approved(state: CaptureState): Promise<string[]> {
  const [s, policy] = await Promise.all([getSettings(), getPolicy()]);
  // An origin the administrator blocked is never part of the approved scope, so a page on it fails closed (Privacy Pause) even as the target.
  return [...(state.targetOrigin ? [state.targetOrigin] : []), ...s.approvedOrigins].filter((o) => !isOriginBlocked(o, policy));
}

// ---------------------------------------------------------------- offscreen document
async function hasOffscreen(): Promise<boolean> {
  const ctx = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  return ctx.length > 0;
}
async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Record the approved tab video (tabCapture stream) outside the ephemeral service worker.',
  });
}
async function closeOffscreen(): Promise<void> {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => undefined);
}
async function sendOff<T = unknown>(op: OffscreenOp): Promise<T | null> {
  if (!(await hasOffscreen())) return null;
  return (await chrome.runtime.sendMessage(op)) as T;
}

// ---------------------------------------------------------------- badge
export async function refreshBadge(state?: CaptureState): Promise<void> {
  const s = state ?? (await getState());
  const d = displayState(s);
  const color: Record<string, string> = {
    inactive: '#6b7280', armed: '#1b7f3b', recording: '#d32f2f', screenshot_only: '#0b5cad', privacy_paused: '#b45309',
    manual_paused: '#b45309', afk: '#6d28d9', target_ended: '#7f1d1d', error: '#7f1d1d',
  };
  await chrome.action.setBadgeText({ text: d.badge });
  await chrome.action.setBadgeBackgroundColor({ color: color[d.code] });
  await chrome.action.setTitle({ title: `ReproDesk - ${d.label}` });
}

// ---------------------------------------------------------------- events / sessions
let lastEventCleanup = 0;
async function cleanupRingEvents(settings: Settings): Promise<void> {
  const now = Date.now();
  if (now - lastEventCleanup < 10_000) return;
  lastEventCleanup = now;
  await deleteEventsRange('ring', 0, now - settings.replaySec * 1000 - 15_000);
}

async function evidenceSession(state: CaptureState): Promise<string> {
  return state.sessionId ?? (state.mode === 'screenshot_only' ? state.shotSessionId : null) ?? 'ring';
}

export async function recordEvent(partial: Omit<TimelineEvent, 'sessionId' | 'ts'> & { ts?: number; sessionId?: string }, state?: CaptureState): Promise<number> {
  const st = state ?? (await getState());
  const ev: TimelineEvent = { ...partial, sessionId: partial.sessionId ?? (await evidenceSession(st)), ts: partial.ts ?? Date.now() };
  const key = (await dbAdd('events', ev)) as number;
  await cleanupRingEvents(await getSettings());
  return key;
}

async function systemEvent(label: string, note?: string, sessionId?: string): Promise<void> {
  await recordEvent({ type: 'system', label, note, system: true, sessionId });
}

async function createSession(kind: SessionKind, state: CaptureState, startedAt: number, settings: Settings): Promise<SessionRecord> {
  const rec: SessionRecord = {
    id: uid('s_'), kind, status: 'active', createdAt: Date.now(), startedAt, endedAt: null, lastCommittedAt: null,
    targetOrigin: state.targetOrigin, environment: settings.environment, browser: browserName(),
    settingsSnapshot: { replaySec: settings.replaySec, tailSec: settings.tailSec, preSessionSec: settings.preSessionSec, fps: settings.fps, bitrateKbps: settings.bitrateKbps },
    preContext: null,
  };
  await dbPut('sessions', rec);
  await dbPut('journal', { key: 'current', sessionId: rec.id, kind, startedAt, updatedAt: Date.now() });
  return rec;
}

async function finalizeSession(id: string, patch: Partial<SessionRecord>): Promise<SessionRecord | null> {
  const rec = await dbGet<SessionRecord>('sessions', id);
  if (!rec) return null;
  const segs = await segmentsOfSession(id);
  const lastCommit = segs.length ? Math.max(...segs.map((s) => s.endWall)) : null;
  const next: SessionRecord = { ...rec, endedAt: rec.endedAt ?? Date.now(), lastCommittedAt: lastCommit ?? rec.lastCommittedAt, ...patch };
  await dbPut('sessions', next);
  const j = await dbGet<{ sessionId: string }>('journal', 'current');
  if (j?.sessionId === id) await dbDelete('journal', 'current');
  return next;
}

async function copyRingEvents(sessionId: string, from: number, to: number): Promise<number> {
  const evs = await eventsOfSession<TimelineEvent>('ring', from, to);
  for (const e of evs) {
    const { id: _id, ...rest } = e;
    void _id;
    await dbAdd('events', { ...rest, sessionId });
  }
  return evs.length;
}

async function openReview(sessionId: string): Promise<void> {
  const rec = await dbGet<SessionRecord>('sessions', sessionId);
  if (rec) await dbPut('sessions', { ...rec, reviewedAt: Date.now() });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`review.html?session=${encodeURIComponent(sessionId)}`) });
}

// ---------------------------------------------------------------- transitions
const OVERLAY_LABELS: Array<[keyof CaptureState, string, string]> = [
  ['privacy', 'Privacy Pause', 'Capture suspended: the approved target is not active/ready. No foreign content is stored.'],
  ['manual', 'Manual Pause', 'Paused by the user.'],
  ['afk', 'AFK', 'Capture suspended: machine locked or idle. No input content is read to decide this.'],
];

export async function dispatch(e: StateEvent): Promise<CaptureState> {
  const prev = await getState();
  const next = reduce(prev, e);
  if (JSON.stringify(prev) !== JSON.stringify(next)) {
    await saveState(next);
    await onTransition(prev, next, e);
  }
  await refreshBadge(next);
  return next;
}

async function onTransition(prev: CaptureState, next: CaptureState, e: StateEvent): Promise<void> {
  if (next.mode !== 'inactive' && !next.terminal) {
    for (const [key, label, note] of OVERLAY_LABELS) {
      if (prev[key] !== next[key]) await systemEvent(next[key] ? `${label} start` : `${label} end`, next[key] ? note : undefined, next.sessionId ?? undefined);
    }
  }
  if (collecting(prev) !== collecting(next) && !next.terminal) {
    await sendOff({ kind: 'off', op: collecting(next) ? 'resume' : 'pause' });
  }
  if (!prev.terminal && next.terminal) await handleTerminal(prev, next, e);
}

async function handleTerminal(prev: CaptureState, next: CaptureState, e: StateEvent): Promise<void> {
  const reason = e.type === 'TARGET_ENDED' || e.type === 'ERROR' ? (e as { reason?: string }).reason ?? '' : '';
  const settings = await getSettings();
  const last = ((await dbGet<HealthSnapshot>('journal', 'health'))?.lastChunkAt ?? Date.now());
  await sendOff({ kind: 'off', op: 'flush' }).catch(() => undefined);
  const sid = prev.sessionId ?? prev.shotSessionId;
  if (next.terminal === 'target_ended') {
    if (sid) {
      await recordEvent({ type: 'system', label: 'Target ended unexpectedly', note: reason || 'Target became unavailable', system: true, ts: last, sessionId: sid });
      await sendOff({ kind: 'off', op: 'pin-stop', sessionId: sid });
      await finalizeSession(sid, { status: 'target_ended', endReason: reason || 'Target became unavailable' });
      if (settings.openReviewAfterSave) await openReview(sid);
    } else if (prev.mode === 'armed') {
      // Evidence of an unexpected failure is exactly what the ring exists for: freeze it instead of letting it age out.
      await runSaveReplay(next, { reason: reason || 'Target became unavailable', status: 'target_ended', skipTail: true, endTs: last });
    }
  } else if (sid) {
    await sendOff({ kind: 'off', op: 'pin-stop', sessionId: sid });
    await finalizeSession(sid, { status: 'recovered', endReason: reason, videoFailure: reason });
  }
  await sendOff({ kind: 'off', op: 'stop' }).catch(() => undefined);
  await closeOffscreen();
}

// ---------------------------------------------------------------- target validation (fail closed)
export async function reevaluate(): Promise<void> {
  const s = await getState();
  if (s.mode === 'inactive' || s.terminal || s.targetTabId == null) return;
  const tab = await chrome.tabs.get(s.targetTabId).catch(() => null);
  if (!tab) {
    await dispatch({ type: 'TARGET_ENDED', reason: 'Target tab closed' });
    return;
  }
  const info = ports.get(s.targetTabId);
  const origins = await approved(s);
  const url = minimizeUrl(tab.url);
  const urlOk = url ? isApprovedOrigin(url.origin, origins) : true; // url is hidden when we have no host access -> rely on the content script
  const ready = !!info && isApprovedOrigin(info.origin, origins) && Date.now() - info.seenAt < LIVENESS_MS;
  const ok = tab.active && ready && urlOk;
  if (!ok && !s.privacy) await dispatch({ type: 'PRIVACY_PAUSE' });
  if (ok && s.privacy) await dispatch({ type: 'PRIVACY_RESUME' });
}

export async function injectContent(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); // some frame refused: top document at least
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------- arm / disarm
async function startCapture(tab: chrome.tabs.Tab, settings: Settings): Promise<void> {
  // The side panel opens at the same moment as the click and shrinks the viewport: let it settle, then capture at the real tab size.
  await new Promise((r) => setTimeout(r, 450));
  const live = await chrome.tabs.get(tab.id!).catch(() => tab);
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await ensureOffscreen();
  const res = await sendOff<{ ok: boolean; error?: string }>({ kind: 'off', op: 'start', streamId, settings, size: live.width && live.height ? { width: live.width, height: live.height } : undefined });
  if (res && res.ok === false) throw new Error(res.error ?? 'Recorder failed to start');
}

export async function armFromTab(tab: chrome.tabs.Tab): Promise<void> {
  const settings = await getSettings();
  const state = await getState();
  const url = minimizeUrl(tab.url);
  if (tab.id == null || tab.windowId == null) return;
  if (!url) {
    await notify('This page cannot be a ReproDesk target (only http/https pages are supported; browser pages are never captured).', 'warn');
    return;
  }
  const verdict = evaluateTarget(url.origin, await getPolicy());
  if (!verdict.ok) {
    await notify(verdict.message, 'warn');
    return;
  }
  const origins = state.targetOrigin ? [state.targetOrigin, ...settings.approvedOrigins] : [];
  if (state.mode !== 'inactive' && !state.terminal) {
    if (state.targetTabId === tab.id) {
      // Clicking the icon again on the target re-grants activeTab (lost on cross-origin navigation) and re-validates the page.
      await injectContent(tab.id);
      await reevaluate();
      await notify('Target re-validated.', 'info');
      return;
    }
    // Active Video Target switch: allowed only inside the approved scope; it needs this fresh user invocation (activeTab).
    if (!isApprovedOrigin(url.origin, origins)) {
      await notify('This tab is outside the approved Target Profile. Disarm first to approve another target.', 'warn');
      return;
    }
    try {
      if (state.mode !== 'screenshot_only') await startCapture(tab, settings);
      await injectContent(tab.id);
      await dispatch({ type: 'SWITCH_TARGET', tabId: tab.id, windowId: tab.windowId });
      await systemEvent('Active Video Target switched', 'Capture moved to another approved tab (a short capture gap is expected).');
    } catch (err) {
      await dispatch({ type: 'ERROR', reason: `Could not move video capture to the new tab: ${err instanceof Error ? err.message : String(err)}` });
    }
    return;
  }
  if (state.terminal) await dispatch({ type: 'DISARM' });
  await dispatch({ type: 'ARM', tabId: tab.id, windowId: tab.windowId, origin: url.origin, video: settings.captureVideo, now: Date.now() });
  await chrome.idle.setDetectionInterval(Math.max(15, (settings.afkMinutes || 10) * 60));
  await chrome.alarms.create('tick', { periodInMinutes: 0.5 });
  const injected = await injectContent(tab.id);
  try {
    if (settings.captureVideo) await startCapture(tab, settings);
  } catch (err) {
    await dispatch({ type: 'ERROR', reason: `Tab capture could not start: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  if (!injected) await notify('Armed, but the page script could not be injected - state stays Privacy Paused until it runs. Reload the tab or use "Remember this site".', 'warn');
  await reevaluate();
}

export async function disarm(): Promise<void> {
  const s = await getState();
  const sid = s.sessionId ?? s.shotSessionId;
  if (s.mode === 'repro' && s.sessionId) await finishRepro();
  else if (sid) await finishShotSession();
  await sendOff({ kind: 'off', op: 'stop' }).catch(() => undefined);
  await closeOffscreen();
  await dispatch({ type: 'DISARM' });
}

// ---------------------------------------------------------------- Instant Replay
interface SaveOpts { reason?: string; status?: SessionRecord['status']; skipTail?: boolean; endTs?: number }
async function runSaveReplay(state: CaptureState, opts: SaveOpts = {}): Promise<string | null> {
  const settings = await getSettings();
  const triggerWall = opts.endTs ?? Date.now();
  const rec = await createSession('instant', state, triggerWall - settings.replaySec * 1000, settings);
  const sessionId = rec.id;
  await recordEvent({ type: 'system', label: 'Save Last Replay', note: 'Instant Replay window pinned', system: true, ts: triggerWall, sessionId: 'ring' });
  void (async () => {
    try {
      const pre = settings.replaySec * 1000;
      const res = await sendOff<PinResult>({ kind: 'off', op: 'save-replay', sessionId, triggerWall, preMs: pre, tailMs: opts.skipTail ? 0 : settings.tailSec * 1000 });
      const start = res?.startWall ?? triggerWall - pre;
      const end = res?.endWall ?? Date.now();
      await copyRingEvents(sessionId, Math.min(start, triggerWall - pre), Date.now());
      const final = await finalizeSession(sessionId, {
        status: opts.status ?? 'finished', startedAt: start, endedAt: end, endReason: opts.reason,
        videoFailure: res?.ok ? undefined : res?.videoError ?? 'No video was available.',
        preContext: null,
      });
      await notify(res?.ok ? 'Replay saved.' : 'Saved without video: ' + (res?.videoError ?? 'buffer empty'), res?.ok ? 'info' : 'warn');
      if (final && settings.openReviewAfterSave) await openReview(sessionId);
    } catch (err) {
      await finalizeSession(sessionId, { status: 'recovered', endReason: String(err), videoFailure: String(err) });
      await notify(`Saving the replay failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  })();
  return sessionId;
}

export async function saveReplay(): Promise<void> {
  const s = await getState();
  if (s.mode !== 'armed' || s.terminal) {
    await notify('Save Last Replay is available while Armed (video on).', 'warn');
    return;
  }
  await notify('Trigger accepted - capturing the post-trigger tail...', 'info');
  await runSaveReplay(s);
}

// ---------------------------------------------------------------- Repro Session
export async function startRepro(afkOverride = false): Promise<void> {
  const s = await getState();
  const settings = await getSettings();
  if (s.terminal) return;
  if (s.mode === 'inactive') {
    await notify('Arm ReproDesk first: click the toolbar icon on the approved tab (browser rules require that user action).', 'warn');
    return;
  }
  if (s.sessionId) return;
  const now = Date.now();
  if (s.mode === 'armed') {
    const rec = await createSession('repro', s, now, settings);
    const pin = await sendOff<PinResult>({ kind: 'off', op: 'pin-start', sessionId: rec.id, startWall: now, preMs: settings.preSessionSec * 1000 });
    const preStart = pin?.startWall != null ? Math.max(pin.startWall, now - settings.preSessionSec * 1000) : null;
    if (preStart != null && settings.preSessionSec > 0 && pin!.segments > 0) {
      await dbPut('sessions', { ...rec, preContext: { startWall: preStart, endWall: now, kept: true } });
      await copyRingEvents(rec.id, preStart, now);
    }
    await dispatch({ type: 'START_REPRO', sessionId: rec.id, now, afkOverride });
    await systemEvent('Repro Session started', undefined, rec.id);
  } else {
    // Screenshot-only: a session without video.
    const rec = s.shotSessionId ? { id: s.shotSessionId } : await createSession('screenshot', s, now, settings);
    await dispatch({ type: 'START_REPRO', sessionId: rec.id, now, afkOverride });
  }
}

/** `openReport`: the person pressed "Finish & review" (or "... & open report"), so the report opens whatever the setting says. */
export async function finishRepro(opts: { openReport?: boolean } = {}): Promise<void> {
  const s = await getState();
  const sid = s.sessionId;
  if (!sid) return;
  await sendOff({ kind: 'off', op: 'pin-stop', sessionId: sid });
  await systemEvent('Repro Session finished', undefined, sid);
  const settings = await getSettings();
  await dispatch({ type: 'FINISH_REPRO' });
  await finalizeSession(sid, { status: 'finished' });
  if (opts.openReport || settings.openReviewAfterSave) await openReview(sid);
}

export async function finishShotSession(opts: { openReport?: boolean } = {}): Promise<void> {
  const s = await getState();
  const sid = s.sessionId ?? s.shotSessionId;
  if (!sid) return;
  await finalizeSession(sid, { status: 'finished' });
  await dispatch(s.sessionId ? { type: 'FINISH_REPRO' } : { type: 'SET_SHOT_SESSION', sessionId: null });
  const settings = await getSettings();
  if (opts.openReport || settings.openReviewAfterSave) await openReview(sid);
}

// ---------------------------------------------------------------- markers + screenshots
const shotQueue: Array<() => Promise<void>> = [];
let shotRunning = false;
async function drainShots(): Promise<void> {
  if (shotRunning) return;
  shotRunning = true;
  while (shotQueue.length) {
    const job = shotQueue.shift()!;
    await job().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 600)); // chrome.tabs.captureVisibleTab is limited to ~2 calls/second
  }
  shotRunning = false;
}

export async function takeScreenshot(opts: { markerOrdinal?: number; markerEventKey?: number } = {}): Promise<void> {
  await reevaluate();
  const s = await getState();
  if (s.mode === 'inactive' || s.terminal || s.targetTabId == null) {
    await notify('Not armed: nothing was captured.', 'warn');
    return;
  }
  if (s.privacy || s.manual || s.afk) {
    // Fail closed: an unapproved visible tab must never be captured, and a failed capture is never presented as success.
    await systemEvent('Screenshot not captured', 'The approved target was not the active, ready tab (or capture was paused).');
    await notify('Screenshot not captured: the approved target is not the active tab or capture is paused.', 'warn');
    return;
  }
  const settings = await getSettings();
  let sid = s.sessionId ?? s.shotSessionId;
  if (!sid) {
    const rec = await createSession('screenshot', s, Date.now(), settings);
    sid = rec.id;
    await dispatch({ type: 'SET_SHOT_SESSION', sessionId: sid });
    await copyRingEvents(sid, Date.now() - Math.min(settings.replaySec, 60) * 1000, Date.now());
  }
  const sessionId = sid;
  const tabId = s.targetTabId;
  const windowId = s.targetWindowId!;
  shotQueue.push(async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      const origins = await approved(s);
      const url = minimizeUrl(tab.url);
      if (!tab.active || (url && !isApprovedOrigin(url.origin, origins))) throw new Error('target no longer the active approved tab');
      const id = uid('shot_');
      const file = `shots/${id}.png`;
      let bytes = 0;
      let viewport: { width: number; height: number } | null = tab.width && tab.height ? { width: tab.width, height: tab.height } : null;
      if (s.mode !== 'screenshot_only' && (await hasOffscreen())) {
        // Preferred path: a frame of the already-approved tab stream. It cannot show any other tab by construction and needs no extra permission.
        const r = await sendOff<{ ok: boolean; bytes?: number; width?: number; height?: number; error?: string }>({ kind: 'off', op: 'screenshot', file });
        if (r?.ok) {
          bytes = r.bytes ?? 0;
          if (r.width && r.height) viewport = { width: r.width, height: r.height };
        } else {
          // No frame yet (e.g. right after a pause on a page that has not repainted): the same validated, active tab can still be
          // captured directly when Chrome's activeTab grant is alive; otherwise the original reason is reported.
          const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }).catch(() => null);
          if (!dataUrl) throw new Error(r?.error ?? 'frame grab failed');
          const blob = await (await fetch(dataUrl)).blob();
          await opfsWrite(file, blob);
          bytes = blob.size;
        }
      } else {
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }); // needs activeTab: toolbar click or shortcut
        const blob = await (await fetch(dataUrl)).blob();
        await opfsWrite(file, blob);
        bytes = blob.size;
      }
      const item: ScreenshotItem = {
        id, sessionId, ts: Date.now(), origin: url?.origin ?? s.targetOrigin, path: url?.path ?? null, title: null,
        browser: browserName(), viewport, captureMode: s.mode, markerOrdinal: opts.markerOrdinal, bytes, file, annotations: [],
      };
      await dbPut('shots', item);
      await recordEvent({ type: 'screenshot', evidenceId: id, label: opts.markerOrdinal ? `Screenshot (Marker ${opts.markerOrdinal})` : 'Screenshot', sessionId });
      if (opts.markerEventKey != null) {
        const ev = await dbGet<TimelineEvent>('events', opts.markerEventKey);
        if (ev) await dbPut('events', { ...ev, evidenceId: id });
      }
    } catch (err) {
      await recordEvent({ type: 'system', label: 'Screenshot failed', note: err instanceof Error ? err.message : String(err), system: true, sessionId });
      await notify('Screenshot failed: ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  });
  void drainShots();
}

export async function addMarker(label?: string): Promise<void> {
  const s = await getState();
  if (!s.sessionId || s.terminal) {
    await notify('Markers belong to a session: start a Repro Session first.', 'warn');
    return;
  }
  const settings = await getSettings();
  const ordinal = s.markerCount + 1;
  await dispatch({ type: 'MARKER_ADDED' });
  const key = await recordEvent({ type: 'marker', label: label?.trim() || `Marker ${ordinal}`, ordinal, sessionId: s.sessionId });
  if (settings.markerScreenshot) void takeScreenshot({ markerOrdinal: ordinal, markerEventKey: key });
}

// ---------------------------------------------------------------- content ports
export function onPort(port: chrome.runtime.Port): void {
  if (!isOwnContentScript(port.sender, chrome.runtime.id)) return;
  const tabId = port.sender!.tab!.id!;
  if (port.name === FRAME_PORT_NAME) {
    port.onMessage.addListener((msg: ContentMessage) => void serial(() => onFrameMessage(tabId, msg)));
    return;
  }
  if (port.name !== PORT_NAME) return;
  ports.set(tabId, { port, origin: null, helloAt: 0, seenAt: 0 });
  port.onMessage.addListener((msg: ContentMessage) => void serial(() => onContentMessage(tabId, port, msg)));
  port.onDisconnect.addListener(() => {
    if (ports.get(tabId)?.port === port) ports.delete(tabId);
    void serial(reevaluate);
  });
}

/** Events from iframes: same rules as the top document - approved origin only, and only while collecting. */
async function onFrameMessage(tabId: number, msg: ContentMessage): Promise<void> {
  if (msg.t !== 'event') return;
  const s = await getState();
  if (s.targetTabId !== tabId || !collectingSemantics(s)) return;
  const origins = await approved(s);
  if (!msg.ev.origin || !isApprovedOrigin(msg.ev.origin, origins)) return;
  await recordEvent({ ...msg.ev, tabId, frame: true }, s);
}

async function onContentMessage(tabId: number, port: chrome.runtime.Port, msg: ContentMessage): Promise<void> {
  const s = await getState();
  if (s.targetTabId !== tabId) return;
  const info = ports.get(tabId);
  if (msg.t === 'hello') {
    if (info) {
      info.origin = msg.origin;
      info.helloAt = Date.now();
      info.seenAt = Date.now();
    } else ports.set(tabId, { port, origin: msg.origin, helloAt: Date.now(), seenAt: Date.now() });
    await reevaluate();
    return;
  }
  if (msg.t === 'ping') {
    if (info) info.seenAt = Date.now();
    if (s.privacy) await reevaluate(); // a live, approved page is back
    return;
  }
  if (msg.t === 'bye') {
    if (info) info.seenAt = 0; // the document is being left: pause right now, before anything else is shown
    await reevaluate();
    return;
  }
  if (info) info.seenAt = Date.now();
  if (msg.t === 'event') {
    if (!collectingSemantics(s)) return; // dropped while paused / AFK / ended
    const origins = await approved(s);
    if (msg.ev.origin && !isApprovedOrigin(msg.ev.origin, origins)) return;
    await recordEvent({ ...msg.ev, tabId }, s);
  }
}

// ---------------------------------------------------------------- off-screen events, tab events, idle, alarms
export async function onOffscreenEvent(m: OffscreenEvent): Promise<void> {
  const s = await getState();
  if (m.ev === 'started') {
    await systemEvent('Video capture started', `${m.codec} ${m.width}x${m.height}`);
  } else if (m.ev === 'ended') {
    if (s.mode === 'inactive' || s.terminal) return;
    const tab = s.targetTabId != null ? await chrome.tabs.get(s.targetTabId).catch(() => null) : null;
    await dispatch(tab ? { type: 'ERROR', reason: m.reason } : { type: 'TARGET_ENDED', reason: 'Target tab closed or crashed' });
  } else if (m.ev === 'error') {
    if (s.mode === 'inactive' || s.terminal) return;
    await dispatch({ type: 'ERROR', reason: m.reason });
  }
}

export async function onTabRemoved(tabId: number): Promise<void> {
  ports.delete(tabId);
  const s = await getState();
  if (s.targetTabId === tabId && s.mode !== 'inactive' && !s.terminal) await dispatch({ type: 'TARGET_ENDED', reason: 'Target tab closed' });
}

export async function onTabUpdated(tabId: number, info: chrome.tabs.OnUpdatedInfo): Promise<void> {
  const s = await getState();
  if (s.targetTabId !== tabId || s.mode === 'inactive' || s.terminal) return;
  // Same-document (SPA) navigations also report status changes, so this only re-evaluates (it does not pause by itself):
  // a real document change shows up as a missing heartbeat / a visible URL that is not approved.
  if (info.status === 'complete') await injectContent(tabId); // guarded in the page: injecting twice is harmless
  await reevaluate();
  // The frozen-page (bfcache) case produces no further events, so look again once the heartbeat is certainly stale.
  if (recheckTimer) clearTimeout(recheckTimer);
  recheckTimer = setTimeout(() => void serial(reevaluate), LIVENESS_MS + 200);
}
let recheckTimer: ReturnType<typeof setTimeout> | null = null;

export async function onIdleState(state: 'active' | 'idle' | 'locked'): Promise<void> {
  const s = await getState();
  if (s.mode === 'inactive' || s.terminal) return;
  const settings = await getSettings();
  if (settings.afkMinutes === 0) return; // AFK protection Off
  if (state === 'locked' || state === 'idle') await dispatch({ type: 'AFK_ENTER' });
  else {
    const next = await dispatch({ type: 'AFK_EXIT' });
    if (!next.afk) await reevaluate();
  }
}

export async function resumeFromAfk(): Promise<void> {
  await dispatch({ type: 'RESUME_FROM_AFK' });
  await reevaluate();
}

/** If the administrator changed the policy while capture is running, a target that is no longer allowed is disarmed at once. */
export async function enforcePolicyNow(): Promise<void> {
  const s = await getState();
  if (s.mode === 'inactive' || s.terminal || !s.targetOrigin) return;
  const verdict = evaluateTarget(s.targetOrigin, await getPolicy());
  if (verdict.ok) return;
  await systemEvent('Stopped by organization policy', verdict.message);
  await disarm();
  await notify(`ReproDesk was disarmed: ${verdict.message}`, 'warn');
}

/** Policy retention: finished sessions older than SessionRetentionDays are deleted (with their video, screenshots, events and reports). */
export async function enforceRetention(force = false): Promise<number> {
  const policy = await getPolicy();
  if (policy.sessionRetentionDays <= 0) return 0;
  const last = ((await chrome.storage.session.get('retentionAt')).retentionAt as number | undefined) ?? 0;
  if (!force && Date.now() - last < 3_600_000) return 0;
  await chrome.storage.session.set({ retentionAt: Date.now() });
  const s = await getState();
  const live = new Set([s.sessionId, s.shotSessionId].filter((x): x is string => !!x));
  const expired = selectExpired(await dbGetAll<SessionRecord>('sessions'), Date.now(), policy.sessionRetentionDays).filter((x) => !live.has(x.id));
  for (const rec of expired) await deleteSession(rec.id);
  return expired.length;
}

export async function tick(): Promise<void> {
  const s = await getState();
  const settings = await getSettings();
  await enforcePolicyNow();
  await enforceRetention();
  await cleanupRingEvents(settings);
  if (s.mode === 'inactive' || s.terminal) {
    await cleanupRing(Date.now(), settings.replaySec * 1000 + 15_000);
    return;
  }
  if (s.mode === 'screenshot_only') return;
  if (!(await hasOffscreen())) {
    await dispatch({ type: 'ERROR', reason: 'The capture document disappeared (browser or extension interrupted capture).' });
    return;
  }
  if (collecting(s)) {
    const h = await dbGet<HealthSnapshot>('journal', 'health');
    if (!h || Date.now() - h.at > 20_000) await dispatch({ type: 'ERROR', reason: 'The capture pipeline stopped responding (no heartbeat).' });
  }
  await reevaluate();
}

// ---------------------------------------------------------------- recovery
export async function recover(): Promise<void> {
  const s = await getState();
  const sessions = await dbGetAll<SessionRecord>('sessions');
  const now = Date.now();
  for (const rec of sessions) {
    const live = s.mode !== 'inactive' && (s.sessionId === rec.id || s.shotSessionId === rec.id);
    if (rec.status === 'active' && !live) {
      const segs = await segmentsOfSession(rec.id);
      const lastCommit = segs.length ? Math.max(...segs.map((x) => x.endWall)) : rec.lastCommittedAt;
      await dbPut('sessions', { ...rec, status: 'recovered', endedAt: rec.endedAt ?? lastCommit ?? now, lastCommittedAt: lastCommit, endReason: 'Recording ended unexpectedly (browser, extension or capture document interrupted).' });
      await recordEvent({ type: 'system', label: 'Recorder interrupted', note: 'Recovered from the last committed evidence.', system: true, ts: lastCommit ?? now, sessionId: rec.id });
    }
    if (rec.status === 'recovered' && !rec.reviewedAt && now - rec.createdAt > RECOVERED_RETENTION_MS) await deleteSession(rec.id);
  }
  const j = await dbGet<{ sessionId: string }>('journal', 'current');
  if (j && !(s.mode !== 'inactive' && (s.sessionId === j.sessionId || s.shotSessionId === j.sessionId))) await dbDelete('journal', 'current');
  await refreshBadge(s);
  await enforceRetention(true);
}

export async function deleteSession(id: string): Promise<void> {
  const shots = await dbIndexAll<ScreenshotItem>('shots', 'sessionId', id);
  for (const sh of shots) await opfsRemove(sh.file);
  await dbDeleteWhereSession('shots', id);
  await dbDeleteWhereSession('events', id);
  await dbDeleteWhereSession('reports', id);
  await unpinSession(id);
  await dbDelete('sessions', id);
}

export { ensureOffscreen, openReview };
