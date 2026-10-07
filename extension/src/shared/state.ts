import type { CaptureState, DisplayCode } from './types';

export const initialState = (): CaptureState => ({
  mode: 'inactive',
  privacy: false,
  manual: false,
  afk: false,
  afkNeedsResume: false,
  terminal: null,
  targetTabId: null,
  targetWindowId: null,
  targetOrigin: null,
  sessionId: null,
  shotSessionId: null,
  reproStartedAt: null,
  armedAt: null,
  markerCount: 0,
  afkOverride: false,
});

export type StateEvent =
  | { type: 'ARM'; tabId: number; windowId: number; origin: string; video: boolean; now: number }
  | { type: 'DISARM' }
  | { type: 'START_REPRO'; sessionId: string; now: number; afkOverride?: boolean }
  | { type: 'FINISH_REPRO' }
  | { type: 'MANUAL_PAUSE' }
  | { type: 'MANUAL_RESUME' }
  | { type: 'PRIVACY_PAUSE' }
  | { type: 'PRIVACY_RESUME' }
  | { type: 'AFK_ENTER' }
  | { type: 'AFK_EXIT' }
  | { type: 'RESUME_FROM_AFK' }
  | { type: 'SET_SHOT_SESSION'; sessionId: string | null }
  | { type: 'MARKER_ADDED' }
  | { type: 'SWITCH_TARGET'; tabId: number; windowId: number }
  | { type: 'TARGET_ENDED'; reason?: string }
  | { type: 'ERROR'; reason: string };

const hasCapture = (s: CaptureState) => s.mode === 'armed' || s.mode === 'repro';

/** Pure reducer: every lifecycle rule of the spec's state machine lives here so it can be unit-tested. */
export function reduce(s: CaptureState, e: StateEvent): CaptureState {
  switch (e.type) {
    case 'ARM':
      return {
        ...initialState(),
        mode: e.video ? 'armed' : 'screenshot_only',
        targetTabId: e.tabId,
        targetWindowId: e.windowId,
        targetOrigin: e.origin,
        armedAt: e.now,
      };
    case 'DISARM':
      return initialState();
    case 'START_REPRO':
      if (s.terminal) return s;
      if (s.mode === 'armed') {
        return { ...s, mode: 'repro', sessionId: e.sessionId, reproStartedAt: e.now, markerCount: 0, manual: false, afkOverride: !!e.afkOverride };
      }
      if (s.mode === 'screenshot_only' && !s.sessionId) {
        return { ...s, sessionId: e.sessionId, reproStartedAt: e.now, markerCount: 0, afkOverride: !!e.afkOverride };
      }
      return s;
    case 'FINISH_REPRO':
      if (s.mode === 'repro') {
        return { ...s, mode: 'armed', sessionId: null, reproStartedAt: null, manual: false, afkOverride: false, afkNeedsResume: false, markerCount: 0 };
      }
      if (s.mode === 'screenshot_only') {
        return { ...s, sessionId: null, shotSessionId: null, reproStartedAt: null, markerCount: 0, afkOverride: false };
      }
      return s;
    case 'MANUAL_PAUSE':
      return hasCapture(s) && !s.terminal ? { ...s, manual: true } : s;
    case 'MANUAL_RESUME':
      return { ...s, manual: false };
    case 'PRIVACY_PAUSE':
      return s.mode === 'inactive' || s.terminal ? s : { ...s, privacy: true };
    case 'PRIVACY_RESUME':
      return { ...s, privacy: false };
    case 'AFK_ENTER':
      if (s.mode === 'inactive' || s.terminal || (s.mode === 'repro' && s.afkOverride)) return s;
      return { ...s, afk: true, afkNeedsResume: false };
    case 'AFK_EXIT':
      if (!s.afk) return s;
      // A deliberate Repro Session never restarts silently after absence.
      return s.mode === 'repro' ? { ...s, afkNeedsResume: true } : { ...s, afk: false, afkNeedsResume: false };
    case 'RESUME_FROM_AFK':
      return { ...s, afk: false, afkNeedsResume: false };
    case 'SET_SHOT_SESSION':
      return { ...s, shotSessionId: e.sessionId };
    case 'MARKER_ADDED':
      return { ...s, markerCount: s.markerCount + 1 };
    case 'SWITCH_TARGET':
      return s.mode === 'inactive' ? s : { ...s, targetTabId: e.tabId, targetWindowId: e.windowId, privacy: false };
    case 'TARGET_ENDED':
      return s.mode === 'inactive' ? s : { ...s, terminal: 'target_ended', reason: e.reason };
    case 'ERROR':
      return s.mode === 'inactive' ? s : { ...s, terminal: 'error', reason: e.reason };
  }
}

/** True when the encoder / collectors should be producing evidence. */
export function collecting(s: CaptureState): boolean {
  return (s.mode === 'armed' || s.mode === 'repro') && !s.privacy && !s.manual && !s.afk && !s.terminal;
}

/** Collectors of semantic events may run in Screenshot-only mode too. */
export function collectingSemantics(s: CaptureState): boolean {
  return s.mode !== 'inactive' && !s.privacy && !s.manual && !s.afk && !s.terminal;
}

export function displayState(s: CaptureState): { code: DisplayCode; label: string; badge: string } {
  if (s.terminal === 'error') return { code: 'error', label: 'ERROR / NOT RECORDING', badge: 'ERR' };
  if (s.terminal === 'target_ended') return { code: 'target_ended', label: 'TARGET ENDED - capture stopped', badge: 'END' };
  if (s.mode === 'inactive') return { code: 'inactive', label: 'INACTIVE', badge: '' };
  if (s.afk) return { code: 'afk', label: 'AFK - CAPTURE SUSPENDED', badge: 'AFK' };
  if (s.manual) return { code: 'manual_paused', label: 'PAUSED - manual', badge: 'PAU' };
  if (s.privacy) return { code: 'privacy_paused', label: 'PRIVACY PAUSED', badge: 'PRV' };
  if (s.mode === 'screenshot_only') return { code: 'screenshot_only', label: 'SCREENSHOTS ONLY / VIDEO OFF', badge: 'SHOT' };
  if (s.mode === 'repro') return { code: 'recording', label: 'REC', badge: 'REC' };
  return { code: 'armed', label: 'ARMED', badge: 'ON' };
}
