// src/shared/types.ts
var DEFAULT_SETTINGS = {
  replaySec: 90,
  tailSec: 5,
  preSessionSec: 30,
  fps: 15,
  bitrateKbps: 1500,
  afkMinutes: 10,
  markerScreenshot: !0,
  captureVideo: !0,
  openReviewAfterSave: !0,
  approvedOrigins: [],
  environment: "QA"
};

// src/shared/policy.ts
var EXPORT_FORMATS = ["zip", "html", "docx", "xlsx", "txt", "md"], NO_POLICY = {
  managed: !1,
  allowedTargetOrigins: null,
  blockedOrigins: [],
  approvedOrigins: [],
  settings: {},
  allowedExportFormats: null,
  allowUnredactedOriginals: !0,
  requireExportConfirmation: !1,
  sessionRetentionDays: 0,
  sampleSessions: !0
}, MAX_LIST = 200, strings = (v) => Array.isArray(v) ? v.filter((x) => typeof x == "string").map((x) => x.trim()).filter(Boolean).slice(0, MAX_LIST) : null, oneOf = (v, allowed) => typeof v == "number" && allowed.includes(v) ? v : void 0, bool = (v) => typeof v == "boolean" ? v : void 0, PLAIN_ORIGIN = /^https?:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:]+\])(?::\d{1,5})?$/i;
function parsePolicy(raw2) {
  if (!raw2 || typeof raw2 != "object") return NO_POLICY;
  let r = raw2, settings2 = {}, replay = oneOf(r.ReplayWindowSec, [30, 60, 90, 120]);
  replay !== void 0 && (settings2.replaySec = replay);
  let tail = oneOf(r.PostTriggerTailSec, [0, 3, 5, 10]);
  tail !== void 0 && (settings2.tailSec = tail);
  let pre = oneOf(r.PreSessionContextSec, [0, 30]);
  pre !== void 0 && (settings2.preSessionSec = pre);
  let afk = oneOf(r.AfkAutoPauseMinutes, [0, 5, 10, 15, 30]);
  afk !== void 0 && (settings2.afkMinutes = afk);
  let marker = bool(r.MarkerScreenshots);
  marker !== void 0 && (settings2.markerScreenshot = marker), bool(r.VideoCaptureAllowed) === !1 && (settings2.captureVideo = !1), typeof r.EnvironmentLabel == "string" && r.EnvironmentLabel.trim() && (settings2.environment = r.EnvironmentLabel.trim().slice(0, 60));
  let allowed = strings(r.AllowedTargetOrigins), fmts = strings(r.AllowedExportFormats), days = typeof r.SessionRetentionDays == "number" && Number.isFinite(r.SessionRetentionDays) ? Math.min(3650, Math.max(0, Math.floor(r.SessionRetentionDays))) : 0, p = {
    managed: !1,
    allowedTargetOrigins: allowed && allowed.length ? allowed : null,
    blockedOrigins: strings(r.BlockedOrigins) ?? [],
    approvedOrigins: (strings(r.ApprovedOrigins) ?? []).filter((o) => PLAIN_ORIGIN.test(o)),
    settings: settings2,
    // An explicit list that names no known format means "none allowed" (fail closed), not "everything".
    allowedExportFormats: fmts ? EXPORT_FORMATS.filter((f) => fmts.map((x) => x.toLowerCase()).includes(f)) : null,
    allowUnredactedOriginals: bool(r.AllowUnredactedOriginals) ?? !0,
    requireExportConfirmation: bool(r.RequireExportConfirmation) ?? !1,
    sessionRetentionDays: days,
    sampleSessions: bool(r.SampleSessionsEnabled) ?? !0
  };
  return p.managed = Object.keys(r).some((k) => r[k] !== void 0 && r[k] !== null), p;
}
function applyPolicy(settings2, policy2) {
  return policy2.managed ? { ...settings2, ...policy2.settings, approvedOrigins: [.../* @__PURE__ */ new Set([...settings2.approvedOrigins, ...policy2.approvedOrigins])] } : settings2;
}
var lockedKeys = (policy2) => Object.keys(policy2.settings);
function stripLocked(patch, policy2) {
  let out = { ...patch };
  for (let k of lockedKeys(policy2)) delete out[k];
  return out;
}

// src/shared/settings.ts
async function getPolicy() {
  try {
    return parsePolicy(await chrome.storage.managed.get(null));
  } catch {
    return NO_POLICY;
  }
}
async function getSettings() {
  let r = await chrome.storage.local.get("settings"), own = { ...DEFAULT_SETTINGS, ...r.settings ?? {} };
  return applyPolicy(own, await getPolicy());
}
async function saveSettings(patch) {
  let policy2 = await getPolicy(), r = await chrome.storage.local.get("settings"), own = { ...DEFAULT_SETTINGS, ...r.settings ?? {} }, clean = stripLocked(patch, policy2);
  return clean.approvedOrigins && (clean.approvedOrigins = clean.approvedOrigins.filter((o) => !policy2.approvedOrigins.includes(o))), await chrome.storage.local.set({ settings: { ...own, ...clean } }), getSettings();
}
function onPolicyChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    area === "managed" && cb();
  });
}

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
async function dbGet(store, key) {
  let db = await openDb();
  return wrap(db.transaction(store).objectStore(store).get(key));
}
async function dbGetAll(store) {
  let db = await openDb();
  return wrap(db.transaction(store).objectStore(store).getAll());
}
async function dbIndexAll(store, index, query) {
  let db = await openDb();
  return wrap(db.transaction(store).objectStore(store).index(index).getAll(query));
}
async function eventsOfSession(sessionId, from = 0, to = Number.MAX_SAFE_INTEGER) {
  return dbIndexAll("events", "sessionTs", IDBKeyRange.bound([sessionId, from], [sessionId, to]));
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
async function opfsRead(path) {
  let { dir, name } = await dirFor(path, !1);
  return (await dir.getFileHandle(name)).getFile();
}
async function opfsExists(path) {
  try {
    return await opfsRead(path), !0;
  } catch {
    return !1;
  }
}
async function storageEstimate() {
  let est = await navigator.storage.estimate(), persisted = await navigator.storage.persisted?.() ?? !1;
  return { usageMB: (est.usage ?? 0) / 1048576, quotaMB: (est.quota ?? 0) / 1048576, persisted };
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
function decodeSegment(buf) {
  let v = new DataView(buf), out = [], o = 0;
  for (; o + 21 <= buf.byteLength; ) {
    let len = v.getUint32(o + 17);
    if (o + 21 + len > buf.byteLength) break;
    out.push({
      key: v.getUint8(o) === 1,
      timestampUs: v.getFloat64(o + 1),
      durationUs: v.getFloat64(o + 9),
      data: new Uint8Array(buf, o + 21, len)
    }), o += 21 + len;
  }
  return out;
}
async function readSegment(id) {
  let f = await opfsRead(segPath(id));
  return decodeSegment(await f.arrayBuffer());
}
var listSegments = () => dbGetAll("segments");
async function segmentsOfSession(sessionId) {
  return (await listSegments()).filter((s) => s.refs.includes(sessionId)).sort((a, b) => a.startWall - b.startWall);
}

// src/demo/sample.ts
var rid = () => Math.random().toString(36).slice(2, 8), base = () => chrome.runtime.getURL("sample/"), isSample = (s) => s.sample === !0;
async function sampleSessionIds() {
  return (await dbGetAll("sessions")).filter(isSample).map((s) => s.id);
}
async function loadSamples(removeOne) {
  if (!(await getPolicy()).sampleSessions) throw new Error("Sample sessions are turned off by your organization.");
  for (let id of await sampleSessionIds()) await removeOne(id);
  let res = await fetch(base() + "index.json");
  if (!res.ok) throw new Error("The sample data is missing from this build.");
  let b = await res.json(), delta = Date.now() - 12e4 - b.anchor, sid = new Map(b.sessions.map((s) => [s.id, `s_sample_${rid()}`])), shotId = new Map(b.shots.map((s) => [s.id, `shot_sample_${rid()}`])), T = (t) => typeof t == "number" ? t + delta : t ?? null, segs = [];
  for (let s of b.segments) {
    let id = `${Math.round(T(s.startWall))}-smp${rid()}`, buf = await (await fetch(base() + s.file)).arrayBuffer(), chunks = decodeSegment(buf).map((c) => ({ ...c, timestampUs: c.timestampUs + delta * 1e3 })), blob = encodeSegment(chunks);
    await opfsWrite(segPath(id), blob);
    let { file: _f, ...meta2 } = s;
    segs.push({ ...meta2, id, startWall: T(s.startWall), endWall: T(s.endWall), bytes: blob.size, refs: s.refs.map((r) => sid.get(r)).filter((r) => !!r) });
  }
  await dbPutMany("segments", segs);
  let shots = [];
  for (let sh of b.shots) {
    let id = shotId.get(sh.id), file = `shots/${id}.png`;
    await opfsWrite(file, await (await fetch(base() + sh.file)).blob());
    let { file: _f, ...rest } = sh;
    shots.push({ ...rest, id, file, sessionId: sid.get(sh.sessionId), ts: T(sh.ts), annotations: [] });
  }
  await dbPutMany("shots", shots);
  let sessions2 = b.sessions.map((s) => ({
    ...s,
    id: sid.get(s.id),
    sample: !0,
    createdAt: T(s.createdAt),
    startedAt: T(s.startedAt),
    endedAt: T(s.endedAt),
    lastCommittedAt: T(s.lastCommittedAt),
    preContext: s.preContext ? { ...s.preContext, startWall: T(s.preContext.startWall), endWall: T(s.preContext.endWall) } : null,
    videoEdits: void 0,
    reviewedAt: void 0
  }));
  await dbPutMany("sessions", sessions2);
  let evs = b.events.map((e) => ({ ...e, sessionId: sid.get(e.sessionId), ts: T(e.ts), evidenceId: e.evidenceId ? shotId.get(e.evidenceId) ?? e.evidenceId : void 0 }));
  await dbPutMany("events", evs);
  for (let r of b.reports) {
    let { sessionKey, ...rep } = r, sessionId = sid.get(sessionKey);
    await dbPut("reports", { ...rep, id: "r_" + sessionId, sessionId, updatedAt: Date.now() });
  }
  return sessions2.map((s) => s.id);
}

// src/shared/state.ts
var initialState = () => ({
  mode: "inactive",
  privacy: !1,
  manual: !1,
  afk: !1,
  afkNeedsResume: !1,
  terminal: null,
  targetTabId: null,
  targetWindowId: null,
  targetOrigin: null,
  sessionId: null,
  shotSessionId: null,
  reproStartedAt: null,
  armedAt: null,
  markerCount: 0,
  afkOverride: !1
});
function collecting(s) {
  return (s.mode === "armed" || s.mode === "repro") && !s.privacy && !s.manual && !s.afk && !s.terminal;
}
function displayState(s) {
  return s.terminal === "error" ? { code: "error", label: "ERROR / NOT RECORDING", badge: "ERR" } : s.terminal === "target_ended" ? { code: "target_ended", label: "TARGET ENDED - capture stopped", badge: "END" } : s.mode === "inactive" ? { code: "inactive", label: "INACTIVE", badge: "" } : s.afk ? { code: "afk", label: "AFK - CAPTURE SUSPENDED", badge: "AFK" } : s.manual ? { code: "manual_paused", label: "PAUSED - manual", badge: "PAU" } : s.privacy ? { code: "privacy_paused", label: "PRIVACY PAUSED", badge: "PRV" } : s.mode === "screenshot_only" ? { code: "screenshot_only", label: "SCREENSHOTS ONLY / VIDEO OFF", badge: "SHOT" } : s.mode === "repro" ? { code: "recording", label: "REC", badge: "REC" } : { code: "armed", label: "ARMED", badge: "ON" };
}

// src/shared/filename.ts
function pad(n2, w = 2) {
  return String(n2).padStart(w, "0");
}
function formatClock(ms) {
  let s = Math.max(0, Math.floor(ms / 1e3));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

// src/report/thumb.ts
var urls = /* @__PURE__ */ new Map();
async function videoFrameThumb(sessionId) {
  let segs = await segmentsOfSession(sessionId);
  if (!segs.length || typeof VideoDecoder > "u") return null;
  let seg2 = segs[Math.floor(segs.length / 2)], key = (await readSegment(seg2.id)).find((c) => c.key);
  return key ? new Promise((resolve) => {
    let done2 = !1, finish = (b) => {
      done2 || (done2 = !0, resolve(b));
    }, dec = new VideoDecoder({
      output: (frame) => {
        let h = Math.round(frame.displayHeight / frame.displayWidth * 360), c = new OffscreenCanvas(360, h);
        c.getContext("2d").drawImage(frame, 0, 0, 360, h), frame.close(), c.convertToBlob({ type: "image/jpeg", quality: 0.82 }).then(finish, () => finish(null));
      },
      error: () => finish(null)
    });
    try {
      dec.configure({ codec: seg2.codec, codedWidth: seg2.width, codedHeight: seg2.height }), dec.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: key.data })), dec.flush().catch(() => finish(null));
    } catch {
      finish(null);
    }
    setTimeout(() => finish(null), 4e3);
  }) : null;
}
async function sessionThumb(sessionId) {
  if (urls.has(sessionId)) return urls.get(sessionId);
  let url = null;
  try {
    let shots = (await dbIndexAll("shots", "sessionId", sessionId)).sort((a, b) => a.ts - b.ts);
    if (shots[0]) url = URL.createObjectURL(await opfsRead(shots[0].file));
    else {
      let path = `thumbs/${sessionId}.jpg`;
      if (!await opfsExists(path)) {
        let blob = await videoFrameThumb(sessionId);
        blob && await opfsWrite(path, blob);
      }
      await opfsExists(path) && (url = URL.createObjectURL(await opfsRead(path)));
    }
  } catch {
    url = null;
  }
  return urls.set(sessionId, url), url;
}

// node_modules/lucide-static/icons/circle-dot.svg
var circle_dot_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-circle-dot"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <circle cx="12" cy="12" r="1" />
  <circle cx="12" cy="12" r="10" />
</svg>
`;

// node_modules/lucide-static/icons/circle.svg
var circle_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-circle"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <circle cx="12" cy="12" r="10" />
</svg>
`;

// node_modules/lucide-static/icons/video.svg
var video_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-video"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
  <rect x="2" y="6" width="14" height="12" rx="2" />
</svg>
`;

// node_modules/lucide-static/icons/camera.svg
var camera_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-camera"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
  <circle cx="12" cy="13" r="3" />
</svg>
`;

// node_modules/lucide-static/icons/flag.svg
var flag_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-flag"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" />
</svg>
`;

// node_modules/lucide-static/icons/pause.svg
var pause_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-pause"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <rect x="14" y="3" width="5" height="18" rx="1" />
  <rect x="5" y="3" width="5" height="18" rx="1" />
</svg>
`;

// node_modules/lucide-static/icons/play.svg
var play_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-play"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
</svg>
`;

// node_modules/lucide-static/icons/square.svg
var square_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-square"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <rect width="18" height="18" x="3" y="3" rx="2" />
</svg>
`;

// node_modules/lucide-static/icons/zap.svg
var zap_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-zap"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z" />
</svg>
`;

// node_modules/lucide-static/icons/shield-check.svg
var shield_check_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-shield-check"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  <path d="m9 12 2 2 4-4" />
</svg>
`;

// node_modules/lucide-static/icons/lock.svg
var lock_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-lock"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
</svg>
`;

// node_modules/lucide-static/icons/clock.svg
var clock_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-clock"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <circle cx="12" cy="12" r="10" />
  <path d="M12 6v6l4 2" />
</svg>
`;

// node_modules/lucide-static/icons/timer.svg
var timer_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-timer"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <line x1="10" x2="14" y1="2" y2="2" />
  <line x1="12" x2="15" y1="14" y2="11" />
  <circle cx="12" cy="14" r="8" />
</svg>
`;

// node_modules/lucide-static/icons/trash-2.svg
var trash_2_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-trash-2"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M10 11v6" />
  <path d="M14 11v6" />
  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  <path d="M3 6h18" />
  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
</svg>
`;

// node_modules/lucide-static/icons/external-link.svg
var external_link_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-external-link"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M15 3h6v6" />
  <path d="M10 14 21 3" />
  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
</svg>
`;

// node_modules/lucide-static/icons/settings.svg
var settings_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-settings"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
  <circle cx="12" cy="12" r="3" />
</svg>
`;

// node_modules/lucide-static/icons/download.svg
var download_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-download"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M12 15V3" />
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
  <path d="m7 10 5 5 5-5" />
</svg>
`;

// node_modules/lucide-static/icons/copy.svg
var copy_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-copy"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
</svg>
`;

// node_modules/lucide-static/icons/file-text.svg
var file_text_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-file-text"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
  <path d="M14 2v5a1 1 0 0 0 1 1h5" />
  <path d="M10 9H8" />
  <path d="M16 13H8" />
  <path d="M16 17H8" />
</svg>
`;

// node_modules/lucide-static/icons/file-code-2.svg
var file_code_2_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-file-code-2"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M4 12.15V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-3.35" />
  <path d="M14 2v5a1 1 0 0 0 1 1h5" />
  <path d="m5 16-3 3 3 3" />
  <path d="m9 22 3-3-3-3" />
</svg>
`;

// node_modules/lucide-static/icons/file-spreadsheet.svg
var file_spreadsheet_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-file-spreadsheet"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
  <path d="M14 2v5a1 1 0 0 0 1 1h5" />
  <path d="M8 13h2" />
  <path d="M14 13h2" />
  <path d="M8 17h2" />
  <path d="M14 17h2" />
</svg>
`;

// node_modules/lucide-static/icons/file-type-2.svg
var file_type_2_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-file-type-2"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M12 22h6a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v6" />
  <path d="M14 2v5a1 1 0 0 0 1 1h5" />
  <path d="M3 16v-1.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5V16" />
  <path d="M6 22h2" />
  <path d="M7 14v8" />
</svg>
`;

// node_modules/lucide-static/icons/archive.svg
var archive_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-archive"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <rect width="20" height="5" x="2" y="3" rx="1" />
  <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
  <path d="M10 12h4" />
</svg>
`;

// node_modules/lucide-static/icons/mouse-pointer-click.svg
var mouse_pointer_click_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-mouse-pointer-click"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M14 4.1 12 6" />
  <path d="m5.1 8-2.9-.8" />
  <path d="m6 12-1.9 2" />
  <path d="M7.2 2.2 8 5.1" />
  <path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z" />
</svg>
`;

// node_modules/lucide-static/icons/navigation.svg
var navigation_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-navigation"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <polygon points="3 11 22 2 13 21 11 13 3 11" />
</svg>
`;

// node_modules/lucide-static/icons/info.svg
var info_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-info"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <circle cx="12" cy="12" r="10" />
  <path d="M12 16v-4" />
  <path d="M12 8h.01" />
</svg>
`;

// node_modules/lucide-static/icons/text-cursor-input.svg
var text_cursor_input_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-text-cursor-input"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6" />
  <path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7" />
  <path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1" />
  <path d="M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1" />
  <path d="M9 6v12" />
</svg>
`;

// node_modules/lucide-static/icons/send.svg
var send_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-send"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
  <path d="m21.854 2.147-10.94 10.939" />
</svg>
`;

// node_modules/lucide-static/icons/x.svg
var x_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-x"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M18 6 6 18" />
  <path d="m6 6 12 12" />
</svg>
`;

// node_modules/lucide-static/icons/check.svg
var check_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-check"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M20 6 9 17l-5-5" />
</svg>
`;

// node_modules/lucide-static/icons/chevron-right.svg
var chevron_right_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-chevron-right"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="m9 18 6-6-6-6" />
</svg>
`;

// node_modules/lucide-static/icons/chevron-down.svg
var chevron_down_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-chevron-down"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="m6 9 6 6 6-6" />
</svg>
`;

// node_modules/lucide-static/icons/triangle-alert.svg
var triangle_alert_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-triangle-alert"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
  <path d="M12 9v4" />
  <path d="M12 17h.01" />
</svg>
`;

// node_modules/lucide-static/icons/moon.svg
var moon_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-moon"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
</svg>
`;

// node_modules/lucide-static/icons/eye-off.svg
var eye_off_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-eye-off"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
  <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
  <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
  <path d="m2 2 20 20" />
</svg>
`;

// node_modules/lucide-static/icons/power.svg
var power_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-power"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M12 2v10" />
  <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
</svg>
`;

// node_modules/lucide-static/icons/history.svg
var history_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-history"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
  <path d="M3 3v5h5" />
  <path d="M12 7v5l4 2" />
</svg>
`;

// node_modules/lucide-static/icons/layers.svg
var layers_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-layers"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
  <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
  <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
</svg>
`;

// node_modules/lucide-static/icons/rewind.svg
var rewind_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-rewind"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M12 6a2 2 0 0 0-3.414-1.414l-6 6a2 2 0 0 0 0 2.828l6 6A2 2 0 0 0 12 18z" />
  <path d="M22 6a2 2 0 0 0-3.414-1.414l-6 6a2 2 0 0 0 0 2.828l6 6A2 2 0 0 0 22 18z" />
</svg>
`;

// node_modules/lucide-static/icons/film.svg
var film_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-film"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <rect width="18" height="18" x="3" y="3" rx="2" />
  <path d="M7 3v18" />
  <path d="M3 7.5h4" />
  <path d="M3 12h18" />
  <path d="M3 16.5h4" />
  <path d="M17 3v18" />
  <path d="M17 7.5h4" />
  <path d="M17 16.5h4" />
</svg>
`;

// node_modules/lucide-static/icons/image.svg
var image_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-image"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
  <circle cx="9" cy="9" r="2" />
  <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
</svg>
`;

// node_modules/lucide-static/icons/globe.svg
var globe_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-globe"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <circle cx="12" cy="12" r="10" />
  <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
  <path d="M2 12h20" />
</svg>
`;

// node_modules/lucide-static/icons/refresh-cw.svg
var refresh_cw_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-refresh-cw"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
  <path d="M21 3v5h-5" />
  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
  <path d="M8 16H3v5" />
</svg>
`;

// node_modules/lucide-static/icons/sparkles.svg
var sparkles_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-sparkles"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
  <path d="M20 2v4" />
  <path d="M22 4h-4" />
  <circle cx="4" cy="20" r="2" />
</svg>
`;

// node_modules/lucide-static/icons/monitor.svg
var monitor_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-monitor"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <rect width="20" height="14" x="2" y="3" rx="2" />
  <line x1="8" x2="16" y1="21" y2="21" />
  <line x1="12" x2="12" y1="17" y2="21" />
</svg>
`;

// node_modules/lucide-static/icons/bookmark.svg
var bookmark_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-bookmark"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z" />
</svg>
`;

// node_modules/lucide-static/icons/list-checks.svg
var list_checks_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-list-checks"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M13 5h8" />
  <path d="M13 12h8" />
  <path d="M13 19h8" />
  <path d="m3 17 2 2 4-4" />
  <path d="m3 7 2 2 4-4" />
</svg>
`;

// node_modules/lucide-static/icons/arrow-left.svg
var arrow_left_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-arrow-left"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="m12 19-7-7 7-7" />
  <path d="M19 12H5" />
</svg>
`;

// node_modules/lucide-static/icons/keyboard.svg
var keyboard_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-keyboard"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M10 8h.01" />
  <path d="M12 12h.01" />
  <path d="M14 8h.01" />
  <path d="M16 12h.01" />
  <path d="M18 8h.01" />
  <path d="M6 8h.01" />
  <path d="M7 16h10" />
  <path d="M8 12h.01" />
  <rect width="20" height="16" x="2" y="4" rx="2" />
</svg>
`;

// node_modules/lucide-static/icons/hard-drive.svg
var hard_drive_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-hard-drive"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M10 16h.01" />
  <path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  <path d="M21.946 12.013H2.054" />
  <path d="M6 16h.01" />
</svg>
`;

// node_modules/lucide-static/icons/scan-eye.svg
var scan_eye_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-scan-eye"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M3 7V5a2 2 0 0 1 2-2h2" />
  <path d="M17 3h2a2 2 0 0 1 2 2v2" />
  <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
  <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
  <circle cx="12" cy="12" r="1" />
  <path d="M18.944 12.33a1 1 0 0 0 0-.66 7.5 7.5 0 0 0-13.888 0 1 1 0 0 0 0 .66 7.5 7.5 0 0 0 13.888 0" />
</svg>
`;

// node_modules/lucide-static/icons/route.svg
var route_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-route"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <circle cx="6" cy="19" r="3" />
  <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
  <circle cx="18" cy="5" r="3" />
</svg>
`;

// node_modules/lucide-static/icons/pencil.svg
var pencil_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-pencil"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
  <path d="m15 5 4 4" />
</svg>
`;

// node_modules/lucide-static/icons/mouse-pointer-2.svg
var mouse_pointer_2_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-mouse-pointer-2"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />
</svg>
`;

// node_modules/lucide-static/icons/move-up-right.svg
var move_up_right_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-move-up-right"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M13 5H19V11" />
  <path d="M19 5L5 19" />
</svg>
`;

// node_modules/lucide-static/icons/minus.svg
var minus_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-minus"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M5 12h14" />
</svg>
`;

// node_modules/lucide-static/icons/type.svg
var type_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-type"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M12 4v16" />
  <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" />
  <path d="M9 20h6" />
</svg>
`;

// node_modules/lucide-static/icons/blend.svg
var blend_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-blend"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <circle cx="15" cy="9" r="7" />
  <circle cx="9" cy="15" r="7" />
</svg>
`;

// node_modules/lucide-static/icons/rectangle-horizontal.svg
var rectangle_horizontal_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-rectangle-horizontal"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <rect width="20" height="12" x="2" y="6" rx="2" />
</svg>
`;

// node_modules/lucide-static/icons/undo-2.svg
var undo_2_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-undo-2"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M9 14 4 9l5-5" />
  <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
</svg>
`;

// node_modules/lucide-static/icons/redo-2.svg
var redo_2_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-redo-2"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="m15 14 5-5-5-5" />
  <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" />
</svg>
`;

// node_modules/lucide-static/icons/rotate-ccw.svg
var rotate_ccw_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-rotate-ccw"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
  <path d="M3 3v5h5" />
</svg>
`;

// node_modules/lucide-static/icons/grid-3x3.svg
var grid_3x3_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-grid-3x3"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <rect width="18" height="18" x="3" y="3" rx="2" />
  <path d="M3 9h18" />
  <path d="M3 15h18" />
  <path d="M9 3v18" />
  <path d="M15 3v18" />
</svg>
`;

// node_modules/lucide-static/icons/scissors.svg
var scissors_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-scissors"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <circle cx="6" cy="6" r="3" />
  <path d="M8.12 8.12 12 12" />
  <path d="M20 4 8.12 15.88" />
  <circle cx="6" cy="18" r="3" />
  <path d="M14.8 14.8 20 20" />
</svg>
`;

// node_modules/lucide-static/icons/crosshair.svg
var crosshair_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-crosshair"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <circle cx="12" cy="12" r="10" />
  <line x1="22" x2="18" y1="12" y2="12" />
  <line x1="6" x2="2" y1="12" y2="12" />
  <line x1="12" x2="12" y1="6" y2="2" />
  <line x1="12" x2="12" y1="22" y2="18" />
</svg>
`;

// node_modules/lucide-static/icons/lock-keyhole.svg
var lock_keyhole_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-lock-keyhole"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <circle cx="12" cy="16" r="1" />
  <rect x="3" y="10" width="18" height="12" rx="2" />
  <path d="M7 10V7a5 5 0 0 1 10 0v3" />
</svg>
`;

// node_modules/lucide-static/icons/shield-alert.svg
var shield_alert_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-shield-alert"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  <path d="M12 8v4" />
  <path d="M12 16h.01" />
</svg>
`;

// node_modules/lucide-static/icons/droplets.svg
var droplets_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-droplets"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z" />
  <path d="M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97" />
</svg>
`;

// node_modules/lucide-static/icons/circle-check.svg
var circle_check_default = `<!-- @license lucide-static v1.52.0 - ISC -->
<svg
  class="lucide lucide-circle-check"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <circle cx="12" cy="12" r="10" />
  <path d="m16 9-5.5 5.5L8 12" />
</svg>
`;

// src/ui/icons.ts
var raw = {
  "circle-dot": circle_dot_default,
  circle: circle_default,
  video: video_default,
  camera: camera_default,
  flag: flag_default,
  pause: pause_default,
  play: play_default,
  square: square_default,
  zap: zap_default,
  "shield-check": shield_check_default,
  lock: lock_default,
  clock: clock_default,
  timer: timer_default,
  "trash-2": trash_2_default,
  "external-link": external_link_default,
  settings: settings_default,
  download: download_default,
  copy: copy_default,
  "file-text": file_text_default,
  "file-code-2": file_code_2_default,
  "file-spreadsheet": file_spreadsheet_default,
  "file-type-2": file_type_2_default,
  archive: archive_default,
  "mouse-pointer-click": mouse_pointer_click_default,
  navigation: navigation_default,
  info: info_default,
  "text-cursor-input": text_cursor_input_default,
  send: send_default,
  x: x_default,
  check: check_default,
  "chevron-right": chevron_right_default,
  "chevron-down": chevron_down_default,
  "triangle-alert": triangle_alert_default,
  moon: moon_default,
  "eye-off": eye_off_default,
  power: power_default,
  history: history_default,
  layers: layers_default,
  rewind: rewind_default,
  film: film_default,
  image: image_default,
  globe: globe_default,
  "refresh-cw": refresh_cw_default,
  sparkles: sparkles_default,
  monitor: monitor_default,
  bookmark: bookmark_default,
  "list-checks": list_checks_default,
  "arrow-left": arrow_left_default,
  keyboard: keyboard_default,
  "hard-drive": hard_drive_default,
  "scan-eye": scan_eye_default,
  route: route_default,
  pencil: pencil_default,
  "mouse-pointer-2": mouse_pointer_2_default,
  "move-up-right": move_up_right_default,
  minus: minus_default,
  type: type_default,
  blend: blend_default,
  "rectangle-horizontal": rectangle_horizontal_default,
  "undo-2": undo_2_default,
  "redo-2": redo_2_default,
  "rotate-ccw": rotate_ccw_default,
  "grid-3x3": grid_3x3_default,
  scissors: scissors_default,
  crosshair: crosshair_default,
  "lock-keyhole": lock_keyhole_default,
  "shield-alert": shield_alert_default,
  droplets: droplets_default,
  "circle-check": circle_check_default
};
function icon(name, cls = "") {
  return raw[name].replace(/<!--[\s\S]*?-->\s*/, "").replace(/\s+class="[^"]*"/, "").replace(/\s+width="24"\s+height="24"/, "").replace("<svg", `<svg class="i ${cls}" aria-hidden="true" focusable="false"`);
}

// src/ui/brand.ts
var n = 0;
function logo(size = 28) {
  let id = `rdg${++n}`;
  return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <defs><linearGradient id="${id}a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#607dff"/><stop offset="1" stop-color="#2438cd"/></linearGradient>
  <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff6363"/><stop offset="1" stop-color="#e2283c"/></linearGradient></defs>
  <rect width="64" height="64" rx="15" fill="url(#${id}a)"/>
  <path d="M49.8 24.8A19.2 19.2 0 1 1 35.99 13.22" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="butt"/>
  <circle cx="35.99" cy="13.22" r="4.8" fill="#fff"/>
  <circle cx="32" cy="32" r="9.6" fill="url(#${id}b)"/></svg>`;
}

// src/ui/format.ts
var esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function ago(ts, now = Date.now()) {
  let s = Math.max(0, Math.round((now - ts) / 1e3));
  return s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(ts).toLocaleDateString(void 0, { month: "short", day: "numeric" });
}
var duration = (ms) => ms == null ? "--:--" : formatClock(ms), bytes = (n2) => n2 >= 1048576 ? `${(n2 / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n2 / 1024))} KB`, host = (origin) => origin ? origin.replace(/^https?:\/\//, "") : "n/a";

// src/sidepanel/index.ts
var app = document.getElementById("app"), state = initialState(), settings, health = null, notice = null, sessions = [], sampleBusy = "", policy = NO_POLICY, isLocked = (k) => lockedKeys(policy).includes(k), lk = (k) => isLocked(k) ? ` <span class="lockfx">${icon("lock")}set by your organization</span>` : "", codecInfo = "", storageInfo = "", remembered = !1, swStarts = 0, view = "main", markerLabel = "", shotCount = 0, meta = /* @__PURE__ */ new Map(), lastSig = "", HEAD = {
  inactive: { icon: "power", title: "Ready when you are", sub: "Not capturing anything" },
  armed: { icon: "circle-dot", title: "Rolling buffer is on", sub: "Only this tab is recorded" },
  recording: { icon: "video", title: "Recording session", sub: "Markers and screenshots on tap" },
  screenshot_only: { icon: "camera", title: "Screenshots only", sub: "No video is being recorded" },
  privacy_paused: { icon: "eye-off", title: "Paused: left the target", sub: "Nothing from other tabs is stored" },
  manual_paused: { icon: "pause", title: "Paused by you", sub: "Resume when you are ready" },
  afk: { icon: "moon", title: "Away: capture suspended", sub: "Resumes when you are back" },
  target_ended: { icon: "square", title: "Target ended", sub: "Evidence so far is frozen" },
  error: { icon: "triangle-alert", title: "Not recording", sub: "The capture pipeline needs attention" }
}, cmd = (c, payload) => chrome.runtime.sendMessage({ kind: "cmd", cmd: c, payload });
function effectiveDisplay() {
  let d = displayState(state);
  return collecting(state) && state.mode !== "screenshot_only" && (!health || Date.now() - health.at > 6e3) && state.armedAt && Date.now() - state.armedAt > 8e3 ? { code: "error", label: "ERROR / NOT RECORDING - no capture heartbeat", badge: "ERR" } : d;
}
var kbds = (keys) => `<span class="kbd">${keys.map((k) => `<kbd>${k}</kbd>`).join("")}</span>`;
function tile(c, ic, title, sub, opts = {}) {
  return `<button class="action ${opts.primary ? "primary" : ""} ${opts.danger ? "danger" : ""} ${opts.compact ? "compact" : ""}"${opts.disabled ? " disabled" : ""} data-c="${c}"${opts.keys ? ` title="Shortcut: ${opts.keys.join("+")}"` : ""}>
    <span class="action__icon">${icon(ic)}</span><span><div class="action__t">${title}</div><div class="action__s">${sub}</div></span>${opts.keys ? kbds(opts.keys) : ""}</button>`;
}
function statusBadge(s) {
  return s.status === "finished" ? '<span class="badge ok">Saved</span>' : s.status === "active" ? '<span class="badge live">Live</span>' : s.status === "target_ended" ? '<span class="badge bad">Target ended</span>' : '<span class="badge warn">Recovered</span>';
}
var KIND = { instant: { icon: "history", name: "Instant Replay" }, repro: { icon: "video", name: "Repro Session" }, screenshot: { icon: "camera", name: "Screenshots" } };
function render() {
  let d = effectiveDisplay(), head = HEAD[d.code], active = state.mode !== "inactive", term = !!state.terminal, repro = state.mode === "repro", shot = state.mode === "screenshot_only", elapsed = state.reproStartedAt && !term ? formatClock(Date.now() - state.reproStartedAt) : "", ringSec = Math.min(settings.replaySec, (health?.ringSegments ?? 0) * 2), ticks = 30, on = Math.ceil(ringSec / settings.replaySec * ticks), recovered = sessions.filter((s) => s.status === "recovered" && !s.reviewedAt), sub = state.terminal && state.reason ? "" : head.sub, active_ = document.activeElement, refocus = active_?.id === "markerLabel" ? { start: active_.selectionStart, end: active_.selectionEnd } : null, body = "";
  view === "settings" ? body = settingsView() : (body += `<div class="hero" data-code="${d.code}" role="status" aria-live="polite">
      <div class="hero__row"><span class="hero__badge">${icon(head.icon)}</span>
        <div style="flex:1;min-width:0"><div class="hero__top"><div class="eyebrow">${esc(d.label)}</div><span class="hero__timer timer">${elapsed}</span></div><div class="hero__label">${head.title}</div><div class="hero__sub">${sub}</div></div></div>
      ${state.reason && term ? `<div class="hero__reason">${esc(state.reason)}</div>` : ""}
      ${active ? `<div class="hero__target">${icon("globe")}<span>Target</span><b>${esc(host(state.targetOrigin))}</b>${shot ? '<span class="pill accent" style="margin-left:auto">video off</span>' : ""}</div>` : ""}
      ${active && !shot && !repro && !term ? `<div class="meter"><div class="meter__head"><span>Rolling buffer</span><b>${ringSec}s of ${settings.replaySec}s</b></div><div class="meter__bar">${Array.from({ length: ticks }, (_, i) => `<i class="${i < on ? "on" : ""}"></i>`).join("")}</div></div>` : ""}
      ${repro && !term ? `<div class="meter"><div class="meter__head"><span>This session</span><b>${state.markerCount} marker${state.markerCount === 1 ? "" : "s"} \xB7 ${shotCount} screenshot${shotCount === 1 ? "" : "s"}</b></div></div>` : ""}
    </div>
    <div class="trust"><span class="chip">${icon("shield-check")}Local only</span><span class="chip">${icon("keyboard")}No keystrokes</span><span class="chip">${icon("monitor")}This tab only</span></div>`, state.afk && state.afkNeedsResume && (body += `<div class="section"><div class="actions">${tile("resumeFromAfk", "play", "Resume recording", "You were away. The session does not restart on its own.", { primary: !0 })}</div></div>`), active ? term ? body += '<div class="section"><div class="actions"><button class="btn primary wide" data-c="ackTerminal" style="height:38px">Dismiss</button></div></div>' : repro ? body += `<div class="section"><h2>Session</h2><div class="markerline"><input class="input" id="markerLabel" placeholder="Name this marker (optional)" value="${esc(markerLabel)}" maxlength="80"></div>
        <div class="actions">${tile("marker", "flag", "Add marker", state.manual || state.privacy ? "Unavailable while paused" : "Flag this moment \xB7 screenshot included", { primary: !0, keys: ["Alt", "Shift", "M"], disabled: state.manual || state.privacy })}
        <div class="actions two">${tile("screenshot", "camera", "Screenshot", "Current view", { compact: !0 })}${state.manual ? tile("manualResume", "play", "Resume", "Continue capture", { compact: !0 }) : tile("manualPause", "pause", "Pause", "Stop collecting", { compact: !0 })}</div>
        ${tile("finishRepro", "square", "Finish & review", "Stop and open the report", { danger: !0 })}</div></div>` : shot ? body += `<div class="section"><h2>Capture</h2><div class="actions">${tile("screenshot", "camera", "Take screenshot", "With target, time and safe context", { primary: !0, keys: ["Alt", "Shift", "S"] })}
        ${state.sessionId || state.shotSessionId ? tile(state.sessionId ? "finishRepro" : "finishShotSession", "square", "Finish screenshot session", "Open the report", { danger: !0 }) : tile("startRepro", "layers", "Start screenshot session", "Group screenshots into one report")}
        <button class="btn ghost wide" data-c="disarm">${icon("power")}Disarm</button></div></div>` : (body += `<div class="section"><h2>Capture</h2><div class="actions">
        ${tile("saveReplay", "history", "Save last replay", `Freeze the last ${settings.replaySec} s + ${settings.tailSec} s tail`, { primary: !0, keys: ["Alt", "Shift", "R"] })}
        ${tile("startRepro", "video", "Start Repro Session", `Record the full path${settings.preSessionSec ? ` \xB7 keeps ${settings.preSessionSec} s before` : ""}`)}
        <div class="actions two">${tile("screenshot", "camera", "Screenshot", "Current view", { compact: !0 })}${state.manual ? tile("manualResume", "play", "Resume", "Continue capture", { compact: !0 }) : tile("manualPause", "pause", "Pause", "Stop collecting", { compact: !0 })}</div>
        <button class="btn ghost wide" data-c="disarm">${icon("power")}Disarm</button></div></div>`, state.shotSessionId && (body += `<div class="section"><button class="btn wide" data-c="finishShotSession">${icon("image")}Finish screenshot collection &amp; open report</button></div>`)) : body += `<div class="section"><div class="card" style="padding:16px"><div style="display:flex;gap:12px;align-items:flex-start"><span class="action__icon" style="width:38px;height:38px">${icon("mouse-pointer-click")}</span><div><div class="action__t" style="font-size:14px">Arm it on the app you test</div><p class="muted" style="margin-top:4px">Open the web app, then <b>click the ReproDesk icon in the toolbar</b>. Chrome only allows tab capture after that explicit action, so nothing can start silently.${policy.allowedTargetOrigins ? ` <span class="faint">Your organization limits ReproDesk to: ${esc(policy.allowedTargetOrigins.join(", "))}.</span>` : ""}</p></div></div></div></div>`, active && !term && !remembered && (body += `<div class="remember">${icon("lock")}<span>Keep capturing across reloads &amp; SSO</span><button class="btn sm" id="remember">Remember site</button></div>`), body += recovered.map((s) => `<div class="recovered"><b>${icon("triangle-alert")}Recovered session</b><p class="small muted" style="margin:4px 0 9px">Recording ended unexpectedly. Last committed ${s.lastCommittedAt ? new Date(s.lastCommittedAt).toLocaleTimeString() : "n/a"}.</p><div style="display:flex;gap:8px"><button class="btn sm primary" data-review="${s.id}">Review</button><button class="btn sm" data-del="${s.id}">Delete</button></div></div>`).join(""), body += `<div class="section"><h2>Recent sessions <span class="count">${sessions.length ? `\xB7 ${sessions.length}` : ""}</span><span style="margin-left:auto;text-transform:none;letter-spacing:0"><button class="btn ghost sm" data-nav="all" style="height:22px;padding:0 6px">View all ${icon("external-link")}</button></span></h2>
      ${sessions.length ? `<div class="sessions">${sessions.slice(0, 4).map(sessionRow).join("")}</div>` : `<div class="empty">${icon("film")}<b>No sessions yet</b><span class="small">Saved replays and Repro Sessions appear here.</span>${policy.sampleSessions ? `<button class="btn sm" id="load-sample" style="margin-top:10px" ${sampleBusy ? "disabled" : ""}>${icon("sparkles")}${sampleBusy || "Try with sample sessions"}</button>` : ""}</div>`}</div>`);
  let toast = notice && Date.now() - notice.at < 9e3 ? `<div class="toast ${notice.level}">${icon(notice.level === "info" ? "info" : "triangle-alert")}<span>${esc(notice.text)}</span></div>` : "";
  if (app.innerHTML = `<div class="panel">
    <div class="topbar"><div class="brand">${logo(26)}<h1>${view === "settings" ? "Settings" : "Capture"}</h1><span class="pill accent">Phase 0</span></div>
      <button class="iconbtn ${view === "settings" ? "on" : ""}" data-nav="${view === "settings" ? "main" : "settings"}" title="${view === "settings" ? "Back" : "Settings & diagnostics"}" aria-label="Settings">${icon(view === "settings" ? "arrow-left" : "settings")}</button></div>
    ${body}${toast}</div>`, refocus) {
    let el = document.getElementById("markerLabel");
    el?.focus(), el?.setSelectionRange(refocus.start, refocus.end);
  }
}
function sessionRow(s) {
  let m = meta.get(s.id), k = KIND[s.kind] ?? KIND.instant, dur = s.endedAt ? duration(s.endedAt - s.startedAt) : "live", counts = `${m?.markers ? `<span>${icon("flag")}${m.markers}</span>` : ""}${m?.shots ? `<span>${icon("camera")}${m.shots}</span>` : ""}`;
  return `<div class="session"><div class="thumb ${s.kind}">${m?.thumb ? `<img src="${m.thumb}" alt="">` : icon(k.icon)}</div>
    <div class="session__body"><div class="session__t"><span>${k.name}</span>${statusBadge(s)}${s.sample ? '<span class="badge">Sample</span>' : ""}</div><div class="session__m"><span>${ago(s.createdAt)}</span><span class="dotsep">\xB7</span><span class="num">${dur}</span>${counts}</div></div>
    <div class="session__act"><button class="iconbtn" data-review="${s.id}" title="Open report" aria-label="Open report">${icon("external-link")}</button><button class="iconbtn" data-del="${s.id}" title="Delete" aria-label="Delete">${icon("trash-2")}</button></div></div>`;
}
function seg(key, values) {
  return `<div class="seg" role="group">${values.map(([v, l]) => `<button data-seg="${key}" data-v="${v}" class="${Number(settings[key]) === v ? "on" : ""}" ${isLocked(key) ? "disabled" : ""}>${l}</button>`).join("")}</div>`;
}
var sw = (key, name) => `<label class="switch"><input type="checkbox" aria-label="${name}" data-sb="${key}" ${settings[key] ? "checked" : ""} ${isLocked(key) ? "disabled" : ""}><span></span></label>`, row = (t, s, ctl) => `<div class="setrow"><div><div class="t">${t}</div><div class="s">${s}</div></div>${ctl}</div>`;
function managedRules() {
  let out = [];
  return policy.allowedTargetOrigins && out.push(`ReproDesk can be armed only on: ${policy.allowedTargetOrigins.join(", ")}`), policy.blockedOrigins.length && out.push(`Never on: ${policy.blockedOrigins.join(", ")}`), policy.settings.captureVideo === !1 && out.push("Video capture is not allowed (Screenshot-only mode)"), policy.allowedExportFormats && out.push(`Exports limited to: ${policy.allowedExportFormats.map((f) => f.toUpperCase()).join(", ") || "none"}`), policy.allowUnredactedOriginals || out.push("Unredacted original screenshots cannot be exported"), policy.requireExportConfirmation && out.push("Every export asks for confirmation"), policy.sessionRetentionDays && out.push(`Finished sessions are deleted after ${policy.sessionRetentionDays} days`), out;
}
function managedBanner() {
  if (!policy.managed) return "";
  let rules = managedRules();
  return `<div class="callout managed" id="managed-banner">${icon("lock-keyhole")}<div><b>Managed by your organization.</b> Your administrator fixed some settings; they show a lock and cannot be changed here.${rules.length ? `<ul>${rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}</div></div>`;
}
function settingsView() {
  let h = health;
  return `${managedBanner()}<div class="section" style="margin-top:4px"><h2>Capture</h2><div class="card drawer">
    ${row("Replay window", "How much is kept while Armed" + lk("replaySec"), seg("replaySec", [[30, "30s"], [60, "60s"], [90, "90s"], [120, "120s"]]))}
    ${row("Post-trigger tail", "Recorded after you press Save" + lk("tailSec"), seg("tailSec", [[0, "0"], [3, "3s"], [5, "5s"], [10, "10s"]]))}
    ${row("Pre-session context", "Kept before a Repro Session starts" + lk("preSessionSec"), seg("preSessionSec", [[0, "Off"], [30, "30s"]]))}
    ${row("AFK suspend", "After this idle time (locked = immediately)" + lk("afkMinutes"), seg("afkMinutes", [[0, "Off"], [5, "5m"], [10, "10m"], [15, "15m"], [30, "30m"]]))}
    ${row("Marker screenshots", "Capture a screenshot with every marker" + lk("markerScreenshot"), sw("markerScreenshot", "Marker screenshots"))}
    ${row("Video capture", (policy.settings.captureVideo === !1 ? "Forbidden: Screenshot-only mode" : "Off = Screenshot-only (applies when arming)") + lk("captureVideo"), sw("captureVideo", "Video capture"))}
    ${row("Open report after saving", "Jump straight to Review", sw("openReviewAfterSave", "Open report after saving"))}</div></div>
    <div class="section"><h2>Target profile</h2><div class="card drawer">
    <div class="field" style="margin-top:10px"><label>Environment</label><input class="input" type="text" aria-label="Environment" data-s="environment" value="${esc(settings.environment)}" ${isLocked("environment") ? "disabled" : ""}>${isLocked("environment") ? `<span class="hint">${icon("lock")}set by your organization</span>` : ""}</div>
    <div class="field"><label>Extra approved origins</label><input class="input" type="text" aria-label="Extra approved origins" data-s="approvedOrigins" value="${esc(settings.approvedOrigins.filter((o) => !policy.approvedOrigins.includes(o)).join(", "))}" placeholder="https://auth.example.com">${policy.approvedOrigins.length ? `<span class="hint">${icon("lock")}Added by your organization: ${esc(policy.approvedOrigins.join(", "))}</span>` : ""}<span class="hint">Comma separated. Same Target Profile, semantic scope only.</span></div></div></div>
    <div class="section"><h2>Quality</h2><div class="card drawer">
    ${row("Frame rate", "Frames per second", seg("fps", [[5, "5"], [10, "10"], [15, "15"], [24, "24"], [30, "30"]]))}
    ${row("Bitrate", "Video quality vs. size", seg("bitrateKbps", [[600, "0.6"], [1e3, "1"], [1500, "1.5"], [2500, "2.5"], [4e3, "4"]]))}</div></div>
    <div class="section"><h2>Shortcuts</h2><div class="card drawer">
    ${row("Save last replay", "", kbds(["Alt", "Shift", "R"]))}${row("Add marker", "", kbds(["Alt", "Shift", "M"]))}${row("Screenshot", "", kbds(["Alt", "Shift", "S"]))}
    ${row("Start / finish session", "Assign at chrome://extensions/shortcuts", '<span class="faint small">unassigned</span>')}</div></div>
    ${policy.sampleSessions ? `<div class="section"><h2>Sample data</h2><div class="card drawer"><p class="muted small" style="margin:0 0 10px">A pre-recorded run of a demo shop (promo code ignored, order fails with E-4021). Use it to try the Review page, the blur / redact tools and every export without recording anything. It is labelled <b>Sample</b>, stays on this device and can be removed at any time.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm primary" id="load-sample" ${sampleBusy ? "disabled" : ""}>${icon("sparkles")}${sampleBusy || (sessions.some((x) => x.sample) ? "Reload sample sessions" : "Load sample sessions")}</button>${sessions.some((x) => x.sample) ? `<button class="btn sm" id="remove-sample" ${sampleBusy ? "disabled" : ""}>${icon("trash-2")}Remove sample sessions</button>` : ""}</div></div></div>` : ""}
    <div class="section"><h2>Diagnostics</h2><div class="card drawer"><div class="kv" style="margin-top:10px">
      <span>Frames encoded</span><span>${h?.framesEncoded ?? 0}</span><span>Dropped</span><span>${h?.framesDropped ?? 0}</span>
      <span>Stream</span><span>${h?.codec ? `${h.codec.startsWith("vp09") ? "VP9" : h.codec} ${h.width}\xD7${h.height}` : "-"}</span>
      <span>Media written</span><span>${bytes(h?.bytesWritten ?? 0)}</span><span>Offscreen heap</span><span>${h?.jsHeapMB ?? "-"} MB</span><span>Service worker starts</span><span>${swStarts}</span></div>
      <pre class="diag" id="diag" tabindex="0" aria-label="Diagnostics">${esc(diagText())}</pre><button class="btn sm" id="copydiag">${icon("copy")}Copy diagnostics JSON</button></div></div>`;
}
function diagText() {
  let h = health;
  return JSON.stringify({
    state: displayState(state).label,
    mode: state.mode,
    privacy: state.privacy,
    manual: state.manual,
    afk: state.afk,
    health: h ? { ...h, ageMs: Date.now() - h.at, ringBytesMB: +(h.ringBytes / 1048576).toFixed(2), writtenMB: +(h.bytesWritten / 1048576).toFixed(2) } : null,
    storage: storageInfo,
    encoders: codecInfo,
    serviceWorkerStarts: swStarts,
    chromeUA: navigator.userAgent,
    policy: policy.managed ? { managed: !0, locked: lockedKeys(policy), allowedTargetOrigins: policy.allowedTargetOrigins, blockedOrigins: policy.blockedOrigins, approvedOrigins: policy.approvedOrigins, allowedExportFormats: policy.allowedExportFormats, allowUnredactedOriginals: policy.allowUnredactedOriginals, requireExportConfirmation: policy.requireExportConfirmation, sessionRetentionDays: policy.sessionRetentionDays, sampleSessions: policy.sampleSessions } : { managed: !1 }
  }, null, 2);
}
app.addEventListener("click", async (e) => {
  let t = e.target.closest("[data-c],[data-review],[data-del],[data-nav],[data-seg],#remember,#copydiag,#load-sample,#remove-sample");
  if (t) {
    if (t.dataset.c)
      t.dataset.c === "marker" ? (cmd("marker", { label: markerLabel }), markerLabel = "", lastSig = "", render()) : cmd(t.dataset.c);
    else if (t.dataset.review) cmd("openReview", { sessionId: t.dataset.review });
    else if (t.dataset.del)
      confirm("Delete this session and its evidence from this browser?") && (await chrome.runtime.sendMessage({ kind: "delete-session", id: t.dataset.del }), await refreshSessions());
    else if (t.dataset.nav)
      t.dataset.nav === "all" ? chrome.tabs.create({ url: chrome.runtime.getURL("review.html") }) : (view = t.dataset.nav, lastSig = "", render());
    else if (t.dataset.seg)
      settings = await saveSettings({ [t.dataset.seg]: Number(t.dataset.v) }), lastSig = "", render();
    else if (t.id === "remember") {
      if (!state.targetOrigin) return;
      await chrome.permissions.request({ origins: [`${state.targetOrigin}/*`] }) && (await cmd("siteRemembered", { origin: state.targetOrigin }), remembered = !0, lastSig = "", render());
    } else if (t.id === "copydiag") navigator.clipboard.writeText(diagText());
    else if (t.id === "load-sample" || t.id === "remove-sample") {
      let removeOne = (id) => chrome.runtime.sendMessage({ kind: "delete-session", id }).then(() => {
      });
      sampleBusy = t.id === "load-sample" ? "Loading\u2026" : "Removing\u2026", lastSig = "", render();
      try {
        if (t.id === "load-sample") await loadSamples(removeOne);
        else for (let id of await sampleSessionIds()) await removeOne(id);
      } catch (err) {
        notice = { text: `Sample data: ${err instanceof Error ? err.message : String(err)}`, level: "error", at: Date.now() };
      } finally {
        sampleBusy = "", await refreshSessions(), lastSig = "", render();
      }
    }
  }
});
app.addEventListener("change", async (e) => {
  let el = e.target;
  if (el.dataset.s) {
    let k = el.dataset.s;
    settings = await saveSettings({ [k]: k === "approvedOrigins" ? el.value.split(",").map((x) => x.trim()).filter(Boolean) : el.value });
  } else el.dataset.sb && (settings = await saveSettings({ [el.dataset.sb]: el.checked }));
});
app.addEventListener("input", (e) => {
  let el = e.target;
  el.id === "markerLabel" && (markerLabel = el.value);
});
app.addEventListener("keydown", (e) => {
  e.target.id === "markerLabel" && e.key === "Enter" && app.querySelector('[data-c="marker"]')?.click();
});
async function loadMeta(s) {
  if (meta.get(s.id)?.thumb && s.status !== "active") return;
  let shots = (await dbIndexAll("shots", "sessionId", s.id)).sort((a, b) => a.ts - b.ts), evs = await eventsOfSession(s.id), thumb = meta.get(s.id)?.thumb ?? (s.status === "active" ? null : await sessionThumb(s.id));
  meta.set(s.id, { thumb, markers: evs.filter((x) => x.type === "marker").length, shots: shots.length });
}
async function refreshSessions() {
  sessions = (await dbGetAll("sessions")).sort((a, b) => b.createdAt - a.createdAt), await Promise.all(sessions.slice(0, 5).map(loadMeta)), state.sessionId || state.shotSessionId ? shotCount = (await dbIndexAll("shots", "sessionId", state.sessionId ?? state.shotSessionId)).length : shotCount = 0, draw();
}
async function detectCodecs() {
  let out = [];
  for (let [name, codec] of [["VP9", "vp09.00.10.08"], ["VP8", "vp8"], ["H.264", "avc1.42001f"], ["AV1", "av01.0.04M.08"]])
    try {
      let r = await VideoEncoder.isConfigSupported({ codec, width: 1280, height: 720, bitrate: 15e5, framerate: 15 });
      out.push(`${name}:${r.supported ? "yes" : "no"}`);
    } catch {
      out.push(`${name}:err`);
    }
  codecInfo = out.join(" ");
}
function draw() {
  let d = effectiveDisplay(), sig = JSON.stringify([policy, state, d.code, view, Math.floor(health?.ringSegments ?? 0), notice?.at, sessions.map((s) => [s.id, s.status, s.endedAt]), [...meta.entries()].map(([k, v]) => [k, v.markers, v.shots, !!v.thumb]), shotCount, remembered, settings, view === "settings" ? [health?.framesEncoded, swStarts] : 0, notice && Date.now() - notice.at < 9e3]);
  sig !== lastSig && (lastSig = sig, render());
  let t = document.querySelector(".timer");
  t && state.reproStartedAt && !state.terminal && (t.textContent = formatClock(Date.now() - state.reproStartedAt));
  let dg = document.getElementById("diag");
  dg && (dg.textContent = diagText());
}
async function poll() {
  health = await dbGet("journal", "health") ?? null, swStarts = (await chrome.storage.session.get("swStarts")).swStarts ?? 0;
  let est = await storageEstimate().catch(() => null);
  est && (storageInfo = `${est.usageMB.toFixed(1)} MB used of ${est.quotaMB.toFixed(0)} MB quota, persisted=${est.persisted}`), state.targetOrigin && (remembered = await chrome.permissions.contains({ origins: [`${state.targetOrigin}/*`] }).catch(() => !1) || remembered), draw();
}
async function main() {
  settings = await getSettings(), policy = await getPolicy(), onPolicyChanged(() => {
    Promise.all([getSettings(), getPolicy()]).then(([st, po]) => {
      settings = st, policy = po, lastSig = "", draw();
    });
  });
  let r = await chrome.storage.session.get(["state", "notice"]);
  state = r.state ?? initialState(), notice = r.notice ?? null, await detectCodecs(), await refreshSessions(), chrome.storage.session.onChanged.addListener((changes) => {
    changes.state && (state = changes.state.newValue ?? initialState()), changes.notice && (notice = changes.notice.newValue ?? null), refreshSessions();
  }), chrome.storage.onChanged.addListener((c, area) => {
    area === "local" && c.settings && (settings = { ...settings, ...c.settings.newValue }, draw());
  }), setInterval(() => {
    poll();
  }, 1e3), setInterval(() => {
    refreshSessions();
  }, 5e3), setInterval(() => draw(), 500);
}
main();
