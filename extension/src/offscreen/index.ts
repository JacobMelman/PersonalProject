// Offscreen capture document: owns the media pipeline (MV3 service workers are ephemeral).
import { RingRecorder } from './ring-recorder';
import type { OffscreenEvent, OffscreenOp, PinResult } from '../shared/messages';
import { pinWindow } from '../storage/segments';
import type { Settings } from '../shared/types';
import { dbPut } from '../storage/db';

let recorder: RingRecorder | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;

const emit = (e: OffscreenEvent) => void chrome.runtime.sendMessage(e).catch(() => undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startRecorder(streamId: string, settings: Settings): Promise<void> {
  await recorder?.stop();
  recorder = new RingRecorder(settings, {
    onEnded: (reason) => emit({ kind: 'off-event', ev: 'ended', reason }),
    onError: (reason) => emit({ kind: 'off-event', ev: 'error', reason }),
    onStarted: (codec, width, height) => emit({ kind: 'off-event', ev: 'started', codec, width, height }),
  });
  await recorder.start(streamId);
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(() => {
    // Offscreen documents only have chrome.runtime, so health goes through IndexedDB (does not wake the service worker).
    if (recorder) void dbPut('journal', { key: 'health', ...recorder.health() });
  }, 1000);
}

async function handle(op: OffscreenOp): Promise<unknown> {
  switch (op.op) {
    case 'start':
      await startRecorder(op.streamId, op.settings);
      return { ok: true };
    case 'stop':
      if (healthTimer) clearInterval(healthTimer);
      healthTimer = null;
      await recorder?.stop();
      recorder = null;
      return { ok: true };
    case 'pause':
      recorder?.pause();
      return { ok: true };
    case 'resume':
      recorder?.resume();
      return { ok: true };
    case 'config':
      recorder?.setSettings(op.settings);
      return { ok: true };
    case 'flush':
      await recorder?.flushNow();
      return { ok: true };
    case 'save-replay': {
      // Pre-trigger window is already in storage; wait for the post-trigger tail, then freeze + pin it.
      if (op.tailMs > 0 && recorder && !recorder.paused) await sleep(op.tailMs);
      await recorder?.flushNow();
      const tailEnd = Date.now();
      const segs = await pinWindow(op.sessionId, op.triggerWall, op.preMs, tailEnd);
      const res: PinResult = {
        ok: segs.length > 0,
        startWall: segs[0]?.startWall ?? null,
        endWall: segs.length ? segs[segs.length - 1].endWall : null,
        segments: segs.length,
        videoError: segs.length ? undefined : 'The rolling buffer was empty (privacy/manual/AFK pause lasted longer than the retention window, or capture just started).',
      };
      return res;
    }
    case 'pin-start': {
      await recorder?.flushNow(); // everything up to "now" is in storage, so the pre-context ends exactly at Start
      const segs = await pinWindow(op.sessionId, op.startWall, op.preMs, op.startWall);
      recorder?.setPinSession(op.sessionId);
      const res: PinResult = { ok: true, startWall: segs[0]?.startWall ?? null, endWall: segs.length ? segs[segs.length - 1].endWall : null, segments: segs.length };
      return res;
    }
    case 'screenshot': {
      if (!recorder) return { ok: false, error: 'no capture stream' };
      return recorder.grabScreenshot(op.file);
    }
    case 'pin-stop':
      await recorder?.flushNow();
      recorder?.setPinSession(null);
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as { kind?: string };
  if (m?.kind !== 'off') return false;
  handle(msg as OffscreenOp).then(
    (r) => sendResponse(r),
    (e) => {
      const reason = e instanceof Error ? e.message : String(e);
      emit({ kind: 'off-event', ev: 'error', reason });
      sendResponse({ ok: false, error: reason });
    },
  );
  return true; // async response
});
