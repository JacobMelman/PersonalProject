// src/storage/db.ts
var DB_NAME = "reprodesk";
var dbPromise = null;
function openDb() {
  return dbPromise || (dbPromise = new Promise((resolve, reject) => {
    let req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      let db = req.result;
      db.createObjectStore("segments", { keyPath: "id" }).createIndex("endWall", "endWall"), db.createObjectStore("events", { keyPath: "id", autoIncrement: !0 }).createIndex("sessionTs", ["sessionId", "ts"]), db.createObjectStore("sessions", { keyPath: "id" }), db.createObjectStore("shots", { keyPath: "id" }).createIndex("sessionId", "sessionId"), db.createObjectStore("reports", { keyPath: "id" }).createIndex("sessionId", "sessionId"), db.createObjectStore("journal", { keyPath: "key" });
    }, req.onsuccess = () => {
      let db = req.result;
      db.onversionchange = () => {
        db.close(), dbPromise = null;
      }, resolve(db);
    }, req.onerror = () => reject(req.error);
  }), dbPromise);
}
function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result), req.onerror = () => reject(req.error);
  });
}
function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(), tx.onerror = () => reject(tx.error), tx.onabort = () => reject(tx.error);
  });
}
async function dbPut(store, value) {
  let tx = (await openDb()).transaction(store, "readwrite");
  tx.objectStore(store).put(value), await done(tx);
}
async function dbPutMany(store, values) {
  if (!values.length) return;
  let tx = (await openDb()).transaction(store, "readwrite"), os = tx.objectStore(store);
  for (let v of values) os.put(v);
  await done(tx);
}
async function dbGetAll(store) {
  let db = await openDb();
  return wrap(db.transaction(store).objectStore(store).getAll());
}
async function dbDelete(store, key) {
  let tx = (await openDb()).transaction(store, "readwrite");
  tx.objectStore(store).delete(key), await done(tx);
}

// src/storage/opfs.ts
async function dirFor(path, create) {
  let parts = path.split("/").filter(Boolean), name = parts.pop(), dir = await navigator.storage.getDirectory();
  for (let p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, name };
}
async function opfsWrite(path, data) {
  let { dir, name } = await dirFor(path, !0), w = await (await dir.getFileHandle(name, { create: !0 })).createWritable();
  try {
    await w.write(data), await w.close();
  } catch (e) {
    throw await w.abort().catch(() => {
    }), e;
  }
}
async function opfsRemove(path) {
  try {
    let { dir, name } = await dirFor(path, !1);
    await dir.removeEntry(name);
  } catch {
  }
}

// src/shared/ring.ts
var sameConfig = (a, b) => a.codec === b.codec && a.width === b.width && a.height === b.height;
function selectEvictable(segments, now, retentionMs) {
  return segments.filter((s) => s.refs.length === 0 && s.endWall < now - retentionMs);
}
function selectWindow(segments, triggerWall, preMs, tailEndWall) {
  let sorted = segments.filter((s) => s.endWall > triggerWall - preMs && s.startWall < tailEndWall).sort((a, b) => a.startWall - b.startWall);
  if (!sorted.length) return [];
  let last = sorted[sorted.length - 1], out = [];
  for (let i = sorted.length - 1; i >= 0 && sameConfig(sorted[i], last); i--)
    out.unshift(sorted[i]);
  return out;
}
function pin(seg, sessionId) {
  return seg.refs.includes(sessionId) ? seg : { ...seg, refs: [...seg.refs, sessionId] };
}

// src/storage/segments.ts
var segPath = (id) => `seg/${id}.bin`;
function encodeSegment(chunks) {
  let parts = [];
  for (let c of chunks) {
    let head = new ArrayBuffer(21), v = new DataView(head);
    v.setUint8(0, c.key ? 1 : 0), v.setFloat64(1, c.timestampUs), v.setFloat64(9, c.durationUs), v.setUint32(17, c.data.byteLength), parts.push(head, c.data);
  }
  return new Blob(parts);
}
async function commitSegment(meta, chunks) {
  let blob = encodeSegment(chunks);
  await opfsWrite(segPath(meta.id), blob), await dbPut("segments", { ...meta, bytes: blob.size });
}
var listSegments = () => dbGetAll("segments");
async function cleanupRing(now, retentionMs) {
  let all = await listSegments(), evict = selectEvictable(all, now, retentionMs);
  for (let s of evict)
    await dbDelete("segments", s.id), await opfsRemove(segPath(s.id));
  let keep = all.filter((s) => !evict.includes(s) && s.refs.length === 0);
  return { removed: evict.length, ringBytes: keep.reduce((a, s) => a + s.bytes, 0), ringSegments: keep.length };
}
async function pinWindow(sessionId, triggerWall, preMs, tailEndWall) {
  let pinned = selectWindow(await listSegments(), triggerWall, preMs, tailEndWall).map((s) => pin(s, sessionId));
  return await dbPutMany("segments", pinned), pinned;
}

// src/offscreen/ring-recorder.ts
var GOP_MS = 2e3, CODEC_CANDIDATES = ["vp09.00.10.08", "vp8"], RingRecorder = class {
  constructor(settings, cb) {
    this.cb = cb;
    this.settings = settings;
  }
  cb;
  settings;
  stream = null;
  encoder = null;
  reader = null;
  running = !1;
  paused = !1;
  codec = "";
  width = 0;
  height = 0;
  lastEncodedUs = 0;
  lastKeyMs = 0;
  forceKey = !0;
  gop = [];
  writeChain = Promise.resolve();
  pinSession = null;
  stats = { framesIn: 0, framesEncoded: 0, framesDropped: 0, segmentsWritten: 0, bytesWritten: 0, lastChunkAt: null };
  ringBytes = 0;
  ringSegments = 0;
  cleanupTimer = null;
  /** The newest frame of the approved tab. Tab capture is damage-driven: no new frame means nothing on screen changed. */
  latest = null;
  shotWaiters = [];
  setSettings(s) {
    this.settings = s;
  }
  async start(streamId, size) {
    let fit = (() => {
      let w0 = size?.width || 1920, h0 = size?.height || 1080, k = Math.min(1, 1920 / w0, 1080 / h0);
      return { w: Math.max(2, Math.round(w0 * k / 2) * 2), h: Math.max(2, Math.round(h0 * k / 2) * 2) };
    })(), constraints = {
      audio: !1,
      // baseline: video only, no tab audio / microphone / camera
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
          maxWidth: fit.w,
          maxHeight: fit.h,
          maxFrameRate: this.settings.fps
        }
      }
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    let track = this.stream.getVideoTracks()[0];
    if (!track) throw new Error("Tab capture returned no video track");
    track.addEventListener("ended", () => this.cb.onEnded("The captured tab stream ended (tab closed, navigated to a protected page, or capture revoked).")), this.running = !0, this.reader = new MediaStreamTrackProcessor({ track }).readable.getReader(), this.pump(), await cleanupRing(Date.now(), this.settings.replaySec * 1e3 + 15e3), this.cleanupTimer = setInterval(() => {
      this.periodicCleanup();
    }, 5e3);
  }
  async periodicCleanup() {
    try {
      let r = await cleanupRing(Date.now(), this.settings.replaySec * 1e3 + GOP_MS * 2);
      this.ringBytes = r.ringBytes, this.ringSegments = r.ringSegments;
    } catch (e) {
      this.cb.onError(`Storage cleanup failed: ${String(e)}`);
    }
  }
  async configure(frame) {
    let w = frame.displayWidth - frame.displayWidth % 2, h = frame.displayHeight - frame.displayHeight % 2, chosen = "";
    for (let codec of CODEC_CANDIDATES) {
      let cfg = {
        codec,
        width: w,
        height: h,
        bitrate: this.settings.bitrateKbps * 1e3,
        framerate: this.settings.fps,
        latencyMode: "realtime",
        bitrateMode: "variable"
      };
      if ((await VideoEncoder.isConfigSupported(cfg)).supported) {
        chosen = codec, this.encoder?.close(), this.encoder = new VideoEncoder({
          output: (chunk) => this.onChunk(chunk),
          error: (e) => this.cb.onError(`Video encoder error: ${e.message}`)
        }), this.encoder.configure(cfg);
        break;
      }
    }
    if (!chosen) throw new Error("No supported WebCodecs video encoder (VP9/VP8) in this browser");
    let first = this.codec === "";
    this.codec = chosen, this.width = w, this.height = h, this.forceKey = !0, first && this.cb.onStarted(chosen, w, h);
  }
  async pump() {
    let reader = this.reader, minGapUs = 1e6 / Math.max(1, this.settings.fps);
    try {
      for (; this.running; ) {
        let { value: raw, done: done2 } = await reader.read();
        if (done2 || !raw) break;
        this.stats.framesIn++;
        let nowMs = Date.now();
        if (this.paused || (this.latest?.close(), this.latest = raw.clone(), this.shotWaiters.length && await this.serveShot(raw)), this.paused || nowMs * 1e3 - this.lastEncodedUs < minGapUs * 0.85) {
          raw.close();
          continue;
        }
        if (this.encoder && this.encoder.encodeQueueSize > 6) {
          this.stats.framesDropped++, raw.close();
          continue;
        }
        try {
          (!this.encoder || raw.displayWidth - raw.displayWidth % 2 !== this.width || raw.displayHeight - raw.displayHeight % 2 !== this.height) && (this.encoder && (await this.encoder.flush(), this.closeGop()), await this.configure(raw));
          let frame = new VideoFrame(raw, { timestamp: nowMs * 1e3 }), key = this.forceKey || nowMs - this.lastKeyMs >= GOP_MS;
          key && (this.lastKeyMs = nowMs, this.forceKey = !1), this.encoder.encode(frame, { keyFrame: key }), frame.close(), this.lastEncodedUs = nowMs * 1e3;
        } catch (e) {
          this.cb.onError(`Frame pipeline failed: ${e instanceof Error ? e.message : String(e)}`), raw.close();
          break;
        }
        raw.close();
      }
    } catch (e) {
      this.running && this.cb.onError(`Capture pipeline stopped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async serveShot(raw) {
    let waiters = this.shotWaiters.splice(0);
    for (let w of waiters)
      try {
        w(await createImageBitmap(raw));
      } catch {
        w(null);
      }
  }
  /** Screenshot straight from the approved tab's own video stream, written to OPFS (messages cannot carry binary data). */
  async grabScreenshot(file) {
    if (this.paused) return { ok: !1, error: "capture is paused" };
    let bmp = await new Promise((resolve) => {
      this.shotWaiters.push(resolve), setTimeout(() => resolve(null), 600);
    });
    if (!bmp && this.latest && (bmp = await createImageBitmap(this.latest).catch(() => null)), !bmp) return { ok: !1, error: "no frame from the target tab yet" };
    let canvas = new OffscreenCanvas(bmp.width, bmp.height);
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    let width = bmp.width, height = bmp.height;
    bmp.close();
    let blob = await canvas.convertToBlob({ type: "image/png" });
    return await opfsWrite(file, blob), { ok: !0, bytes: blob.size, width, height };
  }
  onChunk(chunk) {
    let data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    let isKey = chunk.type === "key";
    isKey && this.gop.length && this.closeGop(), this.gop.push({ key: isKey, timestampUs: chunk.timestamp, durationUs: chunk.duration ?? 1e6 / this.settings.fps, data }), this.stats.framesEncoded++, this.stats.lastChunkAt = Date.now();
  }
  /** Closes the in-memory GOP into a stored segment. Pinned (Repro Session) segments are protected from the first byte. */
  closeGop() {
    if (!this.gop.length) return;
    let chunks = this.gop;
    this.gop = [];
    let last = chunks[chunks.length - 1], meta = {
      id: `${Math.round(chunks[0].timestampUs / 1e3)}-${Math.random().toString(36).slice(2, 7)}`,
      startWall: chunks[0].timestampUs / 1e3,
      endWall: (last.timestampUs + last.durationUs) / 1e3,
      bytes: 0,
      chunkCount: chunks.length,
      codec: this.codec,
      width: this.width,
      height: this.height,
      refs: this.pinSession ? [this.pinSession] : []
    };
    this.writeChain = this.writeChain.then(async () => {
      await commitSegment(meta, chunks), this.stats.segmentsWritten++;
      let b = chunks.reduce((a, c) => a + c.data.byteLength, 0);
      this.stats.bytesWritten += b, meta.refs.length || (this.ringBytes += b, this.ringSegments++);
    }).catch((e) => this.cb.onError(`Storage write failed (quota or disk): ${e instanceof Error ? e.message : String(e)}`));
  }
  /** Finish the current GOP now (used before Save Last Replay / Finish) so the newest frames are in storage. */
  async flushNow() {
    if (this.encoder && this.encoder.state === "configured")
      try {
        await this.encoder.flush();
      } catch {
      }
    this.closeGop(), this.forceKey = !0, await this.writeChain;
  }
  setPinSession(id) {
    this.pinSession = id;
  }
  pause() {
    this.paused || (this.paused = !0, this.latest?.close(), this.latest = null, this.flushNow());
  }
  resume() {
    this.paused = !1, this.forceKey = !0;
  }
  health() {
    let mem = performance.memory;
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
      lastChunkAt: this.stats.lastChunkAt
    };
  }
  async stop() {
    this.running = !1, this.cleanupTimer && clearInterval(this.cleanupTimer);
    try {
      await this.reader?.cancel();
    } catch {
    }
    await this.flushNow();
    try {
      this.encoder?.close();
    } catch {
    }
    this.stream?.getTracks().forEach((t) => t.stop()), this.latest?.close(), this.latest = null, this.stream = null, this.encoder = null;
  }
};

// src/offscreen/index.ts
var recorder = null, healthTimer = null, emit = (e) => {
  chrome.runtime.sendMessage(e).catch(() => {
  });
}, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function startRecorder(streamId, settings, size) {
  await recorder?.stop(), recorder = new RingRecorder(settings, {
    onEnded: (reason) => emit({ kind: "off-event", ev: "ended", reason }),
    onError: (reason) => emit({ kind: "off-event", ev: "error", reason }),
    onStarted: (codec, width, height) => emit({ kind: "off-event", ev: "started", codec, width, height })
  }), await recorder.start(streamId, size), healthTimer && clearInterval(healthTimer), healthTimer = setInterval(() => {
    recorder && dbPut("journal", { key: "health", ...recorder.health() });
  }, 1e3);
}
async function handle(op) {
  switch (op.op) {
    case "start":
      return await startRecorder(op.streamId, op.settings, op.size), { ok: !0 };
    case "stop":
      return healthTimer && clearInterval(healthTimer), healthTimer = null, await recorder?.stop(), recorder = null, { ok: !0 };
    case "pause":
      return recorder?.pause(), { ok: !0 };
    case "resume":
      return recorder?.resume(), { ok: !0 };
    case "config":
      return recorder?.setSettings(op.settings), { ok: !0 };
    case "flush":
      return await recorder?.flushNow(), { ok: !0 };
    case "save-replay": {
      op.tailMs > 0 && recorder && !recorder.paused && await sleep(op.tailMs), await recorder?.flushNow();
      let tailEnd = Date.now(), segs = await pinWindow(op.sessionId, op.triggerWall, op.preMs, tailEnd);
      return {
        ok: segs.length > 0,
        startWall: segs[0]?.startWall ?? null,
        endWall: segs.length ? segs[segs.length - 1].endWall : null,
        segments: segs.length,
        videoError: segs.length ? void 0 : "The rolling buffer was empty (privacy/manual/AFK pause lasted longer than the retention window, or capture just started)."
      };
    }
    case "pin-start": {
      await recorder?.flushNow();
      let segs = await pinWindow(op.sessionId, op.startWall, op.preMs, op.startWall);
      return recorder?.setPinSession(op.sessionId), { ok: !0, startWall: segs[0]?.startWall ?? null, endWall: segs.length ? segs[segs.length - 1].endWall : null, segments: segs.length };
    }
    case "screenshot":
      return recorder ? recorder.grabScreenshot(op.file) : { ok: !1, error: "no capture stream" };
    case "pin-stop":
      return await recorder?.flushNow(), recorder?.setPinSession(null), { ok: !0 };
  }
}
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => msg?.kind !== "off" ? !1 : (handle(msg).then(
  (r) => sendResponse(r),
  (e) => {
    let reason = e instanceof Error ? e.message : String(e);
    emit({ kind: "off-event", ev: "error", reason }), sendResponse({ ok: !1, error: reason });
  }
), !0));
