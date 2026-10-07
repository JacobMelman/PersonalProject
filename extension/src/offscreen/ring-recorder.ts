// Tab video -> WebCodecs encoder -> GOP segments stored in OPFS (+ IDB index). Bounded memory: only the current GOP is kept in RAM.
import { commitSegment, cleanupRing, type StoredChunk } from '../storage/segments';
import type { HealthSnapshot, SegmentMeta, Settings } from '../shared/types';
import { opfsWrite } from '../storage/opfs';

interface MSTProcessor {
  readable: ReadableStream<VideoFrame>;
}
declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => MSTProcessor;

const GOP_MS = 2000;
const CODEC_CANDIDATES = ['vp09.00.10.08', 'vp8'];

export interface RecorderCallbacks {
  onEnded(reason: string): void;
  onError(reason: string): void;
  onStarted(codec: string, width: number, height: number): void;
}

export class RingRecorder {
  private settings: Settings;
  private stream: MediaStream | null = null;
  private encoder: VideoEncoder | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private running = false;
  paused = false;
  private codec = '';
  private width = 0;
  private height = 0;
  private lastEncodedUs = 0;
  private lastKeyMs = 0;
  private forceKey = true;
  private gop: StoredChunk[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private pinSession: string | null = null;
  private stats = { framesIn: 0, framesEncoded: 0, framesDropped: 0, segmentsWritten: 0, bytesWritten: 0, lastChunkAt: null as number | null };
  private ringBytes = 0;
  private ringSegments = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private lastBitmap: ImageBitmap | null = null;
  private lastBitmapAt = 0;
  private shotWaiters: Array<(b: ImageBitmap | null) => void> = [];

  constructor(settings: Settings, private cb: RecorderCallbacks) {
    this.settings = settings;
  }

  setSettings(s: Settings): void {
    this.settings = s;
  }

  async start(streamId: string): Promise<void> {
    const constraints = {
      audio: false, // baseline: video only, no tab audio / microphone / camera
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: this.settings.fps,
        },
      },
    } as unknown as MediaStreamConstraints;
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = this.stream.getVideoTracks()[0];
    if (!track) throw new Error('Tab capture returned no video track');
    track.addEventListener('ended', () => this.cb.onEnded('The captured tab stream ended (tab closed, navigated to a protected page, or capture revoked).'));
    this.running = true;
    this.reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    void this.pump();
    await cleanupRing(Date.now(), this.settings.replaySec * 1000 + 15000);
    this.cleanupTimer = setInterval(() => void this.periodicCleanup(), 5000);
  }

  private async periodicCleanup(): Promise<void> {
    try {
      const r = await cleanupRing(Date.now(), this.settings.replaySec * 1000 + GOP_MS * 2);
      this.ringBytes = r.ringBytes;
      this.ringSegments = r.ringSegments;
    } catch (e) {
      this.cb.onError(`Storage cleanup failed: ${String(e)}`);
    }
  }

  private async configure(frame: VideoFrame): Promise<void> {
    const w = frame.displayWidth - (frame.displayWidth % 2);
    const h = frame.displayHeight - (frame.displayHeight % 2);
    let chosen = '';
    for (const codec of CODEC_CANDIDATES) {
      const cfg: VideoEncoderConfig = {
        codec, width: w, height: h, bitrate: this.settings.bitrateKbps * 1000,
        framerate: this.settings.fps, latencyMode: 'realtime', bitrateMode: 'variable',
      };
      const sup = await VideoEncoder.isConfigSupported(cfg);
      if (sup.supported) {
        chosen = codec;
        this.encoder?.close();
        this.encoder = new VideoEncoder({
          output: (chunk) => this.onChunk(chunk),
          error: (e) => this.cb.onError(`Video encoder error: ${e.message}`),
        });
        this.encoder.configure(cfg);
        break;
      }
    }
    if (!chosen) throw new Error('No supported WebCodecs video encoder (VP9/VP8) in this browser');
    const first = this.codec === '';
    this.codec = chosen;
    this.width = w;
    this.height = h;
    this.forceKey = true;
    if (first) this.cb.onStarted(chosen, w, h);
  }

  private async pump(): Promise<void> {
    const reader = this.reader!;
    const minGapUs = 1_000_000 / Math.max(1, this.settings.fps);
    try {
      while (this.running) {
        const { value: raw, done } = await reader.read();
        if (done || !raw) break;
        this.stats.framesIn++;
        const nowMs = Date.now();
        if (!this.paused && (this.shotWaiters.length || nowMs - this.lastBitmapAt > 1000)) await this.keepBitmap(raw, nowMs);
        if (this.paused || nowMs * 1000 - this.lastEncodedUs < minGapUs * 0.85) {
          raw.close();
          continue;
        }
        if (this.encoder && this.encoder.encodeQueueSize > 6) {
          this.stats.framesDropped++;
          raw.close();
          continue;
        }
        try {
          if (!this.encoder || raw.displayWidth - (raw.displayWidth % 2) !== this.width || raw.displayHeight - (raw.displayHeight % 2) !== this.height) {
            if (this.encoder) {
              await this.encoder.flush();
              this.closeGop();
            }
            await this.configure(raw);
          }
          const frame = new VideoFrame(raw, { timestamp: nowMs * 1000 });
          const key = this.forceKey || nowMs - this.lastKeyMs >= GOP_MS;
          if (key) {
            this.lastKeyMs = nowMs;
            this.forceKey = false;
          }
          this.encoder!.encode(frame, { keyFrame: key });
          frame.close();
          this.lastEncodedUs = nowMs * 1000;
        } catch (e) {
          this.cb.onError(`Frame pipeline failed: ${e instanceof Error ? e.message : String(e)}`);
          raw.close();
          break;
        }
        raw.close();
      }
    } catch (e) {
      if (this.running) this.cb.onError(`Capture pipeline stopped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Keeps ~1 fps worth of the newest frame so a screenshot can be taken even when the page is static (no new frames). */
  private async keepBitmap(raw: VideoFrame, nowMs: number): Promise<void> {
    try {
      const bmp = await createImageBitmap(raw);
      this.lastBitmap?.close();
      this.lastBitmap = bmp;
      this.lastBitmapAt = nowMs;
      const waiters = this.shotWaiters.splice(0);
      waiters.forEach((w) => w(bmp));
    } catch {
      /* frame unavailable */
    }
  }

  /** Screenshot straight from the approved tab's own video stream, written to OPFS (messages cannot carry binary data). */
  async grabScreenshot(file: string): Promise<{ ok: boolean; bytes?: number; width?: number; height?: number; error?: string }> {
    if (this.paused) return { ok: false, error: 'capture is paused' };
    const fresh = await new Promise<ImageBitmap | null>((resolve) => {
      this.shotWaiters.push(resolve);
      setTimeout(() => resolve(null), 800);
    });
    const bmp = fresh ?? (this.lastBitmap && Date.now() - this.lastBitmapAt < 5000 ? this.lastBitmap : null);
    if (!bmp) return { ok: false, error: 'no recent frame from the target tab' };
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    await opfsWrite(file, blob);
    return { ok: true, bytes: blob.size, width: bmp.width, height: bmp.height };
  }

  private onChunk(chunk: EncodedVideoChunk): void {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const isKey = chunk.type === 'key';
    if (isKey && this.gop.length) this.closeGop();
    this.gop.push({ key: isKey, timestampUs: chunk.timestamp, durationUs: chunk.duration ?? 1_000_000 / this.settings.fps, data });
    this.stats.framesEncoded++;
    this.stats.lastChunkAt = Date.now();
  }

  /** Closes the in-memory GOP into a stored segment. Pinned (Repro Session) segments are protected from the first byte. */
  private closeGop(): void {
    if (!this.gop.length) return;
    const chunks = this.gop;
    this.gop = [];
    const last = chunks[chunks.length - 1];
    const meta: SegmentMeta = {
      id: `${Math.round(chunks[0].timestampUs / 1000)}-${Math.random().toString(36).slice(2, 7)}`,
      startWall: chunks[0].timestampUs / 1000,
      endWall: (last.timestampUs + last.durationUs) / 1000,
      bytes: 0,
      chunkCount: chunks.length,
      codec: this.codec,
      width: this.width,
      height: this.height,
      refs: this.pinSession ? [this.pinSession] : [],
    };
    this.writeChain = this.writeChain
      .then(async () => {
        await commitSegment(meta, chunks);
        this.stats.segmentsWritten++;
        const b = chunks.reduce((a, c) => a + c.data.byteLength, 0);
        this.stats.bytesWritten += b;
        if (!meta.refs.length) {
          this.ringBytes += b;
          this.ringSegments++;
        }
      })
      .catch((e) => this.cb.onError(`Storage write failed (quota or disk): ${e instanceof Error ? e.message : String(e)}`));
  }

  /** Finish the current GOP now (used before Save Last Replay / Finish) so the newest frames are in storage. */
  async flushNow(): Promise<void> {
    if (this.encoder && this.encoder.state === 'configured') {
      try {
        await this.encoder.flush();
      } catch {
        /* encoder closed */
      }
    }
    this.closeGop();
    this.forceKey = true; // next frame starts a fresh, independently decodable GOP
    await this.writeChain;
  }

  setPinSession(id: string | null): void {
    this.pinSession = id;
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    void this.flushNow();
  }

  resume(): void {
    this.paused = false;
    this.forceKey = true;
  }

  health(): HealthSnapshot {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      at: Date.now(),
      framesIn: this.stats.framesIn,
      framesEncoded: this.stats.framesEncoded,
      framesDropped: this.stats.framesDropped,
      segmentsWritten: this.stats.segmentsWritten,
      bytesWritten: this.stats.bytesWritten,
      ringBytes: this.ringBytes,
      ringSegments: this.ringSegments,
      encoderQueue: this.encoder?.encodeQueueSize ?? 0,
      codec: this.codec,
      width: this.width,
      height: this.height,
      jsHeapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
      paused: this.paused,
      lastChunkAt: this.stats.lastChunkAt,
    };
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    await this.flushNow();
    try {
      this.encoder?.close();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.lastBitmap?.close();
    this.lastBitmap = null;
    this.stream = null;
    this.encoder = null;
  }
}

