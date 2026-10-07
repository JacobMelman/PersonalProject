import { describe, expect, it } from 'vitest';
import { collecting, collectingSemantics, displayState, initialState, reduce } from '../../src/shared/state';
import type { CaptureState } from '../../src/shared/types';

const arm = (video = true): CaptureState => reduce(initialState(), { type: 'ARM', tabId: 7, windowId: 1, origin: 'https://qa.example', video, now: 1000 });

describe('state machine', () => {
  it('starts inactive', () => {
    expect(displayState(initialState()).code).toBe('inactive');
    expect(collecting(initialState())).toBe(false);
  });
  it('ARM -> armed and collecting', () => {
    const s = arm();
    expect(displayState(s).code).toBe('armed');
    expect(collecting(s)).toBe(true);
  });
  it('screenshot-only never collects video but allows semantics', () => {
    const s = arm(false);
    expect(displayState(s).code).toBe('screenshot_only');
    expect(collecting(s)).toBe(false);
    expect(collectingSemantics(s)).toBe(true);
  });
  it('privacy pause is distinct from manual pause and auto-resumable', () => {
    let s = reduce(arm(), { type: 'PRIVACY_PAUSE' });
    expect(displayState(s).code).toBe('privacy_paused');
    expect(collecting(s)).toBe(false);
    s = reduce(s, { type: 'MANUAL_PAUSE' });
    expect(displayState(s).code).toBe('manual_paused');
    s = reduce(s, { type: 'PRIVACY_RESUME' });
    expect(collecting(s)).toBe(false); // manual pause never auto-resumes
    s = reduce(s, { type: 'MANUAL_RESUME' });
    expect(collecting(s)).toBe(true);
  });
  it('Armed auto-resumes after AFK, a Repro Session does not', () => {
    let armed = reduce(arm(), { type: 'AFK_ENTER' });
    expect(displayState(armed).code).toBe('afk');
    armed = reduce(armed, { type: 'AFK_EXIT' });
    expect(displayState(armed).code).toBe('armed');

    let repro = reduce(arm(), { type: 'START_REPRO', sessionId: 's1', now: 2000 });
    expect(displayState(repro).code).toBe('recording');
    repro = reduce(repro, { type: 'AFK_ENTER' });
    repro = reduce(repro, { type: 'AFK_EXIT' });
    expect(repro.afk).toBe(true);
    expect(repro.afkNeedsResume).toBe(true);
    expect(collecting(repro)).toBe(false);
    repro = reduce(repro, { type: 'RESUME_FROM_AFK' });
    expect(collecting(repro)).toBe(true);
  });
  it('per-session AFK override ignores AFK in a Repro Session', () => {
    let s = reduce(arm(), { type: 'START_REPRO', sessionId: 's1', now: 2000, afkOverride: true });
    s = reduce(s, { type: 'AFK_ENTER' });
    expect(s.afk).toBe(false);
    expect(collecting(s)).toBe(true);
  });
  it('terminal states stop collection and win in the display', () => {
    let s = reduce(arm(), { type: 'START_REPRO', sessionId: 's1', now: 2000 });
    s = reduce(s, { type: 'TARGET_ENDED', reason: 'tab closed' });
    expect(displayState(s).code).toBe('target_ended');
    expect(collecting(s)).toBe(false);
    s = reduce(s, { type: 'PRIVACY_RESUME' });
    expect(collecting(s)).toBe(false);
    const e = reduce(arm(), { type: 'ERROR', reason: 'encoder died' });
    expect(displayState(e).label).toMatch(/NOT RECORDING/);
  });
  it('finish returns to armed and clears the session', () => {
    let s = reduce(arm(), { type: 'START_REPRO', sessionId: 's1', now: 2000 });
    s = reduce(s, { type: 'MARKER_ADDED' });
    s = reduce(s, { type: 'FINISH_REPRO' });
    expect(s.mode).toBe('armed');
    expect(s.sessionId).toBeNull();
    expect(s.markerCount).toBe(0);
  });
  it('cannot start a Repro Session from inactive', () => {
    expect(reduce(initialState(), { type: 'START_REPRO', sessionId: 'x', now: 1 }).mode).toBe('inactive');
  });
  it('DISARM resets everything', () => {
    expect(reduce(arm(), { type: 'DISARM' })).toEqual(initialState());
  });
});

describe('manifest policy', () => {
  it('requests no microphone/camera/audio capture permissions and no broad host access', async () => {
    const { readFileSync } = await import('node:fs');
    const m = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
    const all = [...(m.permissions ?? []), ...(m.host_permissions ?? [])];
    expect(all).not.toEqual(expect.arrayContaining(['audioCapture', 'videoCapture', 'debugger', 'tabs', '<all_urls>', 'clipboardRead', 'webRequest', 'cookies']));
    expect(m.host_permissions).toBeUndefined(); // hosts are optional and granted per site by the user
    expect(m.minimum_chrome_version).toBe('116');
  });
});
