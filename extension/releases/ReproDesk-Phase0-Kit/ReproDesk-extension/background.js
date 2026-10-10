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
}), hasCapture = (s) => s.mode === "armed" || s.mode === "repro";
function reduce(s, e) {
  switch (e.type) {
    case "ARM":
      return {
        ...initialState(),
        mode: e.video ? "armed" : "screenshot_only",
        targetTabId: e.tabId,
        targetWindowId: e.windowId,
        targetOrigin: e.origin,
        armedAt: e.now
      };
    case "DISARM":
      return initialState();
    case "START_REPRO":
      return s.terminal ? s : s.mode === "armed" ? { ...s, mode: "repro", sessionId: e.sessionId, reproStartedAt: e.now, markerCount: 0, manual: !1, afkOverride: !!e.afkOverride } : s.mode === "screenshot_only" && !s.sessionId ? { ...s, sessionId: e.sessionId, reproStartedAt: e.now, markerCount: 0, afkOverride: !!e.afkOverride } : s;
    case "FINISH_REPRO":
      return s.mode === "repro" ? { ...s, mode: "armed", sessionId: null, reproStartedAt: null, manual: !1, afkOverride: !1, afkNeedsResume: !1, markerCount: 0 } : s.mode === "screenshot_only" ? { ...s, sessionId: null, shotSessionId: null, reproStartedAt: null, markerCount: 0, afkOverride: !1 } : s;
    case "MANUAL_PAUSE":
      return hasCapture(s) && !s.terminal ? { ...s, manual: !0 } : s;
    case "MANUAL_RESUME":
      return { ...s, manual: !1 };
    case "PRIVACY_PAUSE":
      return s.mode === "inactive" || s.terminal ? s : { ...s, privacy: !0 };
    case "PRIVACY_RESUME":
      return { ...s, privacy: !1 };
    case "AFK_ENTER":
      return s.mode === "inactive" || s.terminal || s.mode === "repro" && s.afkOverride ? s : { ...s, afk: !0, afkNeedsResume: !1 };
    case "AFK_EXIT":
      return s.afk ? s.mode === "repro" ? { ...s, afkNeedsResume: !0 } : { ...s, afk: !1, afkNeedsResume: !1 } : s;
    case "RESUME_FROM_AFK":
      return { ...s, afk: !1, afkNeedsResume: !1 };
    case "SET_SHOT_SESSION":
      return { ...s, shotSessionId: e.sessionId };
    case "MARKER_ADDED":
      return { ...s, markerCount: s.markerCount + 1 };
    case "SWITCH_TARGET":
      return s.mode === "inactive" ? s : { ...s, targetTabId: e.tabId, targetWindowId: e.windowId, privacy: !1 };
    case "TARGET_ENDED":
      return s.mode === "inactive" ? s : { ...s, terminal: "target_ended", reason: e.reason };
    case "ERROR":
      return s.mode === "inactive" ? s : { ...s, terminal: "error", reason: e.reason };
  }
}
function collecting(s) {
  return (s.mode === "armed" || s.mode === "repro") && !s.privacy && !s.manual && !s.afk && !s.terminal;
}
function collectingSemantics(s) {
  return s.mode !== "inactive" && !s.privacy && !s.manual && !s.afk && !s.terminal;
}
function displayState(s) {
  return s.terminal === "error" ? { code: "error", label: "ERROR / NOT RECORDING", badge: "ERR" } : s.terminal === "target_ended" ? { code: "target_ended", label: "TARGET ENDED - capture stopped", badge: "END" } : s.mode === "inactive" ? { code: "inactive", label: "INACTIVE", badge: "" } : s.afk ? { code: "afk", label: "AFK - CAPTURE SUSPENDED", badge: "AFK" } : s.manual ? { code: "manual_paused", label: "PAUSED - manual", badge: "PAU" } : s.privacy ? { code: "privacy_paused", label: "PRIVACY PAUSED", badge: "PRV" } : s.mode === "screenshot_only" ? { code: "screenshot_only", label: "SCREENSHOTS ONLY / VIDEO OFF", badge: "SHOT" } : s.mode === "repro" ? { code: "recording", label: "REC", badge: "REC" } : { code: "armed", label: "ARMED", badge: "ON" };
}

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
function parsePolicy(raw) {
  if (!raw || typeof raw != "object") return NO_POLICY;
  let r = raw, settings = {}, replay = oneOf(r.ReplayWindowSec, [30, 60, 90, 120]);
  replay !== void 0 && (settings.replaySec = replay);
  let tail = oneOf(r.PostTriggerTailSec, [0, 3, 5, 10]);
  tail !== void 0 && (settings.tailSec = tail);
  let pre = oneOf(r.PreSessionContextSec, [0, 30]);
  pre !== void 0 && (settings.preSessionSec = pre);
  let afk = oneOf(r.AfkAutoPauseMinutes, [0, 5, 10, 15, 30]);
  afk !== void 0 && (settings.afkMinutes = afk);
  let marker = bool(r.MarkerScreenshots);
  marker !== void 0 && (settings.markerScreenshot = marker), bool(r.VideoCaptureAllowed) === !1 && (settings.captureVideo = !1), typeof r.EnvironmentLabel == "string" && r.EnvironmentLabel.trim() && (settings.environment = r.EnvironmentLabel.trim().slice(0, 60));
  let allowed = strings(r.AllowedTargetOrigins), fmts = strings(r.AllowedExportFormats), days = typeof r.SessionRetentionDays == "number" && Number.isFinite(r.SessionRetentionDays) ? Math.min(3650, Math.max(0, Math.floor(r.SessionRetentionDays))) : 0, p = {
    managed: !1,
    allowedTargetOrigins: allowed && allowed.length ? allowed : null,
    blockedOrigins: strings(r.BlockedOrigins) ?? [],
    approvedOrigins: (strings(r.ApprovedOrigins) ?? []).filter((o) => PLAIN_ORIGIN.test(o)),
    settings,
    // An explicit list that names no known format means "none allowed" (fail closed), not "everything".
    allowedExportFormats: fmts ? EXPORT_FORMATS.filter((f) => fmts.map((x) => x.toLowerCase()).includes(f)) : null,
    allowUnredactedOriginals: bool(r.AllowUnredactedOriginals) ?? !0,
    requireExportConfirmation: bool(r.RequireExportConfirmation) ?? !1,
    sessionRetentionDays: days,
    sampleSessions: bool(r.SampleSessionsEnabled) ?? !0
  };
  return p.managed = Object.keys(r).some((k) => r[k] !== void 0 && r[k] !== null), p;
}
var PATTERN = /^(\*|https?):\/\/(\*|\*\.[a-z0-9.-]+|[a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\*|\d{1,5}))?$/i, ORIGIN = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/i;
function matchOrigin(pattern, origin) {
  let p = PATTERN.exec(pattern.trim()), o = ORIGIN.exec(origin);
  if (!p || !o) return !1;
  let [, ps, ph, pp] = p, [, os, oh, op] = o;
  if (ps !== "*" && ps.toLowerCase() !== os.toLowerCase()) return !1;
  let host = oh.toLowerCase(), pHost = ph.toLowerCase();
  if (pHost.startsWith("*.")) {
    let base = pHost.slice(2);
    if (!(host === base || host.endsWith("." + base))) return !1;
  } else if (pHost !== "*" && pHost !== host) return !1;
  if (pp === "*") return !0;
  let def = os.toLowerCase() === "https" ? "443" : "80";
  return (op ?? def) === (pp ?? def);
}
function evaluateTarget(origin, policy) {
  return policy.blockedOrigins.some((p) => matchOrigin(p, origin)) ? { ok: !1, reason: "blocked", message: "Your organization does not allow ReproDesk on this site." } : policy.allowedTargetOrigins && !policy.allowedTargetOrigins.some((p) => matchOrigin(p, origin)) ? { ok: !1, reason: "not-allowed", message: "Your organization allows ReproDesk only on approved sites, and this one is not on the list." } : { ok: !0 };
}
var isOriginBlocked = (origin, policy) => policy.blockedOrigins.some((p) => matchOrigin(p, origin));
function applyPolicy(settings, policy) {
  return policy.managed ? { ...settings, ...policy.settings, approvedOrigins: [.../* @__PURE__ */ new Set([...settings.approvedOrigins, ...policy.approvedOrigins])] } : settings;
}
var lockedKeys = (policy) => Object.keys(policy.settings);
function stripLocked(patch, policy) {
  let out = { ...patch };
  for (let k of lockedKeys(policy)) delete out[k];
  return out;
}
function selectExpired(sessions, now, days) {
  if (days <= 0) return [];
  let cutoff = now - days * 864e5;
  return sessions.filter((s) => s.status !== "active" && (s.endedAt ?? s.createdAt) < cutoff);
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
  let policy = await getPolicy(), r = await chrome.storage.local.get("settings"), own = { ...DEFAULT_SETTINGS, ...r.settings ?? {} }, clean = stripLocked(patch, policy);
  return clean.approvedOrigins && (clean.approvedOrigins = clean.approvedOrigins.filter((o) => !policy.approvedOrigins.includes(o))), await chrome.storage.local.set({ settings: { ...own, ...clean } }), getSettings();
}
function onPolicyChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    area === "managed" && cb();
  });
}

// src/shared/privacy.ts
function minimizeUrl(href) {
  if (!href) return null;
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let path = u.pathname.split("/").map((seg) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ? ":id" : seg.length >= 24 && /\d/.test(seg) && /[A-Za-z]/.test(seg) ? ":token" : seg).join("/");
  return { origin: u.origin, path: path || "/" };
}
function isApprovedOrigin(origin, approved2) {
  return origin ? approved2.includes(origin) : !1;
}

// src/shared/messages.ts
var PORT_NAME = "rd-content", FRAME_PORT_NAME = "rd-frame";

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
async function dbAdd(store, value) {
  let tx = (await openDb()).transaction(store, "readwrite"), key = await wrap(tx.objectStore(store).add(value));
  return await done(tx), key;
}
async function dbGet(store, key) {
  let db = await openDb();
  return wrap(db.transaction(store).objectStore(store).get(key));
}
async function dbGetAll(store) {
  let db = await openDb();
  return wrap(db.transaction(store).objectStore(store).getAll());
}
async function dbDelete(store, key) {
  let tx = (await openDb()).transaction(store, "readwrite");
  tx.objectStore(store).delete(key), await done(tx);
}
async function dbIndexAll(store, index, query) {
  let db = await openDb();
  return wrap(db.transaction(store).objectStore(store).index(index).getAll(query));
}
async function eventsOfSession(sessionId, from = 0, to = Number.MAX_SAFE_INTEGER) {
  return dbIndexAll("events", "sessionTs", IDBKeyRange.bound([sessionId, from], [sessionId, to]));
}
async function deleteEventsRange(sessionId, from, to) {
  let tx = (await openDb()).transaction("events", "readwrite"), idx = tx.objectStore("events").index("sessionTs"), n = 0;
  return await new Promise((resolve, reject) => {
    let cur = idx.openCursor(IDBKeyRange.bound([sessionId, from], [sessionId, to]));
    cur.onsuccess = () => {
      let c = cur.result;
      if (!c) return resolve();
      c.delete(), n++, c.continue();
    }, cur.onerror = () => reject(cur.error);
  }), await done(tx), n;
}
async function dbDeleteWhereSession(store, sessionId) {
  if (store === "events") {
    await deleteEventsRange(sessionId, 0, Number.MAX_SAFE_INTEGER);
    return;
  }
  let rows = await dbIndexAll(store, "sessionId", sessionId);
  for (let r of rows) await dbDelete(store, r.id);
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
function selectEvictable(segments, now, retentionMs) {
  return segments.filter((s) => s.refs.length === 0 && s.endWall < now - retentionMs);
}
function deletable(seg) {
  return seg.refs.length === 0;
}

// src/storage/segments.ts
var segPath = (id) => `seg/${id}.bin`;
var listSegments = () => dbGetAll("segments");
async function segmentsOfSession(sessionId) {
  return (await listSegments()).filter((s) => s.refs.includes(sessionId)).sort((a, b) => a.startWall - b.startWall);
}
async function cleanupRing(now, retentionMs) {
  let all = await listSegments(), evict = selectEvictable(all, now, retentionMs);
  for (let s of evict)
    await dbDelete("segments", s.id), await opfsRemove(segPath(s.id));
  let keep = all.filter((s) => !evict.includes(s) && s.refs.length === 0);
  return { removed: evict.length, ringBytes: keep.reduce((a, s) => a + s.bytes, 0), ringSegments: keep.length };
}
async function unpinSession(sessionId) {
  let mine = await segmentsOfSession(sessionId);
  for (let s of mine) {
    let next = { ...s, refs: s.refs.filter((r) => r !== sessionId) };
    deletable(next) ? (await dbDelete("segments", s.id), await opfsRemove(segPath(s.id))) : await dbPut("segments", next);
  }
}

// src/shared/trust.ts
function isOwnExtensionPage(sender, extensionId, baseUrl) {
  return !!sender && sender.id === extensionId && typeof sender.url == "string" && sender.url.startsWith(baseUrl);
}
function isOwnContentScript(sender, extensionId) {
  return !!sender && sender.id === extensionId && sender.tab?.id != null;
}
function isRememberableOrigin(origin) {
  return typeof origin == "string" && origin.length <= 253 && /^https?:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:]+\])(?::\d{1,5})?$/i.test(origin);
}

// src/background/core.ts
var STATE_KEY = "state", RECOVERED_RETENTION_MS = 168 * 3600 * 1e3, uid = (p = "") => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), chain = Promise.resolve();
function serial(fn) {
  let run = chain.then(fn, fn);
  return chain = run.catch(() => {
  }), run;
}
async function getState() {
  return (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] ?? initialState();
}
async function saveState(s) {
  await chrome.storage.session.set({ [STATE_KEY]: s });
}
async function notify(text, level = "info") {
  await chrome.storage.session.set({ notice: { text, level, at: Date.now() } });
}
var LIVENESS_MS = 3500, ports = /* @__PURE__ */ new Map(), browserName = () => {
  let m = /Chrome\/([\d.]+)/.exec(navigator.userAgent), edge = /Edg\/([\d.]+)/.exec(navigator.userAgent);
  return edge ? `Edge ${edge[1]}` : m ? `Chrome ${m[1]}` : navigator.userAgent;
};
async function approved(state) {
  let [s, policy] = await Promise.all([getSettings(), getPolicy()]);
  return [...state.targetOrigin ? [state.targetOrigin] : [], ...s.approvedOrigins].filter((o) => !isOriginBlocked(o, policy));
}
async function hasOffscreen() {
  return (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length > 0;
}
async function ensureOffscreen() {
  await hasOffscreen() || await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Record the approved tab video (tabCapture stream) outside the ephemeral service worker."
  });
}
async function closeOffscreen() {
  await hasOffscreen() && await chrome.offscreen.closeDocument().catch(() => {
  });
}
async function sendOff(op) {
  return await hasOffscreen() ? await chrome.runtime.sendMessage(op) : null;
}
async function refreshBadge(state) {
  let s = state ?? await getState(), d = displayState(s), color = {
    inactive: "#6b7280",
    armed: "#1b7f3b",
    recording: "#d32f2f",
    screenshot_only: "#0b5cad",
    privacy_paused: "#b45309",
    manual_paused: "#b45309",
    afk: "#6d28d9",
    target_ended: "#7f1d1d",
    error: "#7f1d1d"
  };
  await chrome.action.setBadgeText({ text: d.badge }), await chrome.action.setBadgeBackgroundColor({ color: color[d.code] }), await chrome.action.setTitle({ title: `ReproDesk - ${d.label}` });
}
var lastEventCleanup = 0;
async function cleanupRingEvents(settings) {
  let now = Date.now();
  now - lastEventCleanup < 1e4 || (lastEventCleanup = now, await deleteEventsRange("ring", 0, now - settings.replaySec * 1e3 - 15e3));
}
async function evidenceSession(state) {
  return state.sessionId ?? (state.mode === "screenshot_only" ? state.shotSessionId : null) ?? "ring";
}
async function recordEvent(partial, state) {
  let st = state ?? await getState(), ev = { ...partial, sessionId: partial.sessionId ?? await evidenceSession(st), ts: partial.ts ?? Date.now() }, key = await dbAdd("events", ev);
  return await cleanupRingEvents(await getSettings()), key;
}
async function systemEvent(label, note, sessionId) {
  await recordEvent({ type: "system", label, note, system: !0, sessionId });
}
async function createSession(kind, state, startedAt, settings) {
  let rec = {
    id: uid("s_"),
    kind,
    status: "active",
    createdAt: Date.now(),
    startedAt,
    endedAt: null,
    lastCommittedAt: null,
    targetOrigin: state.targetOrigin,
    environment: settings.environment,
    browser: browserName(),
    settingsSnapshot: { replaySec: settings.replaySec, tailSec: settings.tailSec, preSessionSec: settings.preSessionSec, fps: settings.fps, bitrateKbps: settings.bitrateKbps },
    preContext: null
  };
  return await dbPut("sessions", rec), await dbPut("journal", { key: "current", sessionId: rec.id, kind, startedAt, updatedAt: Date.now() }), rec;
}
async function finalizeSession(id, patch) {
  let rec = await dbGet("sessions", id);
  if (!rec) return null;
  let segs = await segmentsOfSession(id), lastCommit = segs.length ? Math.max(...segs.map((s) => s.endWall)) : null, next = { ...rec, endedAt: rec.endedAt ?? Date.now(), lastCommittedAt: lastCommit ?? rec.lastCommittedAt, ...patch };
  return await dbPut("sessions", next), (await dbGet("journal", "current"))?.sessionId === id && await dbDelete("journal", "current"), next;
}
async function copyRingEvents(sessionId, from, to) {
  let evs = await eventsOfSession("ring", from, to);
  for (let e of evs) {
    let { id: _id, ...rest } = e;
    await dbAdd("events", { ...rest, sessionId });
  }
  return evs.length;
}
async function openReview(sessionId) {
  let rec = await dbGet("sessions", sessionId);
  rec && await dbPut("sessions", { ...rec, reviewedAt: Date.now() }), await chrome.tabs.create({ url: chrome.runtime.getURL(`review.html?session=${encodeURIComponent(sessionId)}`) });
}
var OVERLAY_LABELS = [
  ["privacy", "Privacy Pause", "Capture suspended: the approved target is not active/ready. No foreign content is stored."],
  ["manual", "Manual Pause", "Paused by the user."],
  ["afk", "AFK", "Capture suspended: machine locked or idle. No input content is read to decide this."]
];
async function dispatch(e) {
  let prev = await getState(), next = reduce(prev, e);
  return JSON.stringify(prev) !== JSON.stringify(next) && (await saveState(next), await onTransition(prev, next, e)), await refreshBadge(next), next;
}
async function onTransition(prev, next, e) {
  if (next.mode !== "inactive" && !next.terminal)
    for (let [key, label, note] of OVERLAY_LABELS)
      prev[key] !== next[key] && await systemEvent(next[key] ? `${label} start` : `${label} end`, next[key] ? note : void 0, next.sessionId ?? void 0);
  collecting(prev) !== collecting(next) && !next.terminal && await sendOff({ kind: "off", op: collecting(next) ? "resume" : "pause" }), !prev.terminal && next.terminal && await handleTerminal(prev, next, e);
}
async function handleTerminal(prev, next, e) {
  let reason = e.type === "TARGET_ENDED" || e.type === "ERROR" ? e.reason ?? "" : "", settings = await getSettings(), last = (await dbGet("journal", "health"))?.lastChunkAt ?? Date.now();
  await sendOff({ kind: "off", op: "flush" }).catch(() => {
  });
  let sid = prev.sessionId ?? prev.shotSessionId;
  next.terminal === "target_ended" ? sid ? (await recordEvent({ type: "system", label: "Target ended unexpectedly", note: reason || "Target became unavailable", system: !0, ts: last, sessionId: sid }), await sendOff({ kind: "off", op: "pin-stop", sessionId: sid }), await finalizeSession(sid, { status: "target_ended", endReason: reason || "Target became unavailable" }), settings.openReviewAfterSave && await openReview(sid)) : prev.mode === "armed" && await runSaveReplay(next, { reason: reason || "Target became unavailable", status: "target_ended", skipTail: !0, endTs: last }) : sid && (await sendOff({ kind: "off", op: "pin-stop", sessionId: sid }), await finalizeSession(sid, { status: "recovered", endReason: reason, videoFailure: reason })), await sendOff({ kind: "off", op: "stop" }).catch(() => {
  }), await closeOffscreen();
}
async function reevaluate() {
  let s = await getState();
  if (s.mode === "inactive" || s.terminal || s.targetTabId == null) return;
  let tab = await chrome.tabs.get(s.targetTabId).catch(() => null);
  if (!tab) {
    await dispatch({ type: "TARGET_ENDED", reason: "Target tab closed" });
    return;
  }
  let info = ports.get(s.targetTabId), origins = await approved(s), url = minimizeUrl(tab.url), urlOk = url ? isApprovedOrigin(url.origin, origins) : !0, ready = !!info && isApprovedOrigin(info.origin, origins) && Date.now() - info.seenAt < LIVENESS_MS, ok = tab.active && ready && urlOk;
  !ok && !s.privacy && await dispatch({ type: "PRIVACY_PAUSE" }), ok && s.privacy && await dispatch({ type: "PRIVACY_RESUME" });
}
async function injectContent(tabId) {
  try {
    return await chrome.scripting.executeScript({ target: { tabId, allFrames: !0 }, files: ["content.js"] }), !0;
  } catch {
    try {
      return await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }), !0;
    } catch {
      return !1;
    }
  }
}
async function startCapture(tab, settings) {
  await new Promise((r) => setTimeout(r, 450));
  let live = await chrome.tabs.get(tab.id).catch(() => tab), streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await ensureOffscreen();
  let res = await sendOff({ kind: "off", op: "start", streamId, settings, size: live.width && live.height ? { width: live.width, height: live.height } : void 0 });
  if (res && res.ok === !1) throw new Error(res.error ?? "Recorder failed to start");
}
async function armFromTab(tab) {
  let settings = await getSettings(), state = await getState(), url = minimizeUrl(tab.url);
  if (tab.id == null || tab.windowId == null) return;
  if (!url) {
    await notify("This page cannot be a ReproDesk target (only http/https pages are supported; browser pages are never captured).", "warn");
    return;
  }
  let verdict = evaluateTarget(url.origin, await getPolicy());
  if (!verdict.ok) {
    await notify(verdict.message, "warn");
    return;
  }
  let origins = state.targetOrigin ? [state.targetOrigin, ...settings.approvedOrigins] : [];
  if (state.mode !== "inactive" && !state.terminal) {
    if (state.targetTabId === tab.id) {
      await injectContent(tab.id), await reevaluate(), await notify("Target re-validated.", "info");
      return;
    }
    if (!isApprovedOrigin(url.origin, origins)) {
      await notify("This tab is outside the approved Target Profile. Disarm first to approve another target.", "warn");
      return;
    }
    try {
      state.mode !== "screenshot_only" && await startCapture(tab, settings), await injectContent(tab.id), await dispatch({ type: "SWITCH_TARGET", tabId: tab.id, windowId: tab.windowId }), await systemEvent("Active Video Target switched", "Capture moved to another approved tab (a short capture gap is expected).");
    } catch (err) {
      await dispatch({ type: "ERROR", reason: `Could not move video capture to the new tab: ${err instanceof Error ? err.message : String(err)}` });
    }
    return;
  }
  state.terminal && await dispatch({ type: "DISARM" }), await dispatch({ type: "ARM", tabId: tab.id, windowId: tab.windowId, origin: url.origin, video: settings.captureVideo, now: Date.now() }), await chrome.idle.setDetectionInterval(Math.max(15, (settings.afkMinutes || 10) * 60)), await chrome.alarms.create("tick", { periodInMinutes: 0.5 });
  let injected = await injectContent(tab.id);
  try {
    settings.captureVideo && await startCapture(tab, settings);
  } catch (err) {
    await dispatch({ type: "ERROR", reason: `Tab capture could not start: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  injected || await notify('Armed, but the page script could not be injected - state stays Privacy Paused until it runs. Reload the tab or use "Remember this site".', "warn"), await reevaluate();
}
async function disarm() {
  let s = await getState(), sid = s.sessionId ?? s.shotSessionId;
  s.mode === "repro" && s.sessionId ? await finishRepro() : sid && await finishShotSession(), await sendOff({ kind: "off", op: "stop" }).catch(() => {
  }), await closeOffscreen(), await dispatch({ type: "DISARM" });
}
async function runSaveReplay(state, opts = {}) {
  let settings = await getSettings(), triggerWall = opts.endTs ?? Date.now(), sessionId = (await createSession("instant", state, triggerWall - settings.replaySec * 1e3, settings)).id;
  return await recordEvent({ type: "system", label: "Save Last Replay", note: "Instant Replay window pinned", system: !0, ts: triggerWall, sessionId: "ring" }), (async () => {
    try {
      let pre = settings.replaySec * 1e3, res = await sendOff({ kind: "off", op: "save-replay", sessionId, triggerWall, preMs: pre, tailMs: opts.skipTail ? 0 : settings.tailSec * 1e3 }), start = res?.startWall ?? triggerWall - pre, end = res?.endWall ?? Date.now();
      await copyRingEvents(sessionId, Math.min(start, triggerWall - pre), Date.now());
      let final = await finalizeSession(sessionId, {
        status: opts.status ?? "finished",
        startedAt: start,
        endedAt: end,
        endReason: opts.reason,
        videoFailure: res?.ok ? void 0 : res?.videoError ?? "No video was available.",
        preContext: null
      });
      await notify(res?.ok ? "Replay saved." : "Saved without video: " + (res?.videoError ?? "buffer empty"), res?.ok ? "info" : "warn"), final && settings.openReviewAfterSave && await openReview(sessionId);
    } catch (err) {
      await finalizeSession(sessionId, { status: "recovered", endReason: String(err), videoFailure: String(err) }), await notify(`Saving the replay failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  })(), sessionId;
}
async function saveReplay() {
  let s = await getState();
  if (s.mode !== "armed" || s.terminal) {
    await notify("Save Last Replay is available while Armed (video on).", "warn");
    return;
  }
  await notify("Trigger accepted - capturing the post-trigger tail...", "info"), await runSaveReplay(s);
}
async function startRepro(afkOverride = !1) {
  let s = await getState(), settings = await getSettings();
  if (s.terminal) return;
  if (s.mode === "inactive") {
    await notify("Arm ReproDesk first: click the toolbar icon on the approved tab (browser rules require that user action).", "warn");
    return;
  }
  if (s.sessionId) return;
  let now = Date.now();
  if (s.mode === "armed") {
    let rec = await createSession("repro", s, now, settings), pin2 = await sendOff({ kind: "off", op: "pin-start", sessionId: rec.id, startWall: now, preMs: settings.preSessionSec * 1e3 }), preStart = pin2?.startWall != null ? Math.max(pin2.startWall, now - settings.preSessionSec * 1e3) : null;
    preStart != null && settings.preSessionSec > 0 && pin2.segments > 0 && (await dbPut("sessions", { ...rec, preContext: { startWall: preStart, endWall: now, kept: !0 } }), await copyRingEvents(rec.id, preStart, now)), await dispatch({ type: "START_REPRO", sessionId: rec.id, now, afkOverride }), await systemEvent("Repro Session started", void 0, rec.id);
  } else {
    let rec = s.shotSessionId ? { id: s.shotSessionId } : await createSession("screenshot", s, now, settings);
    await dispatch({ type: "START_REPRO", sessionId: rec.id, now, afkOverride });
  }
}
async function finishRepro(opts = {}) {
  let sid = (await getState()).sessionId;
  if (!sid) return;
  await sendOff({ kind: "off", op: "pin-stop", sessionId: sid }), await systemEvent("Repro Session finished", void 0, sid);
  let settings = await getSettings();
  await dispatch({ type: "FINISH_REPRO" }), await finalizeSession(sid, { status: "finished" }), (opts.openReport || settings.openReviewAfterSave) && await openReview(sid);
}
async function finishShotSession(opts = {}) {
  let s = await getState(), sid = s.sessionId ?? s.shotSessionId;
  if (!sid) return;
  await finalizeSession(sid, { status: "finished" }), await dispatch(s.sessionId ? { type: "FINISH_REPRO" } : { type: "SET_SHOT_SESSION", sessionId: null });
  let settings = await getSettings();
  (opts.openReport || settings.openReviewAfterSave) && await openReview(sid);
}
var shotQueue = [], shotRunning = !1;
async function drainShots() {
  if (!shotRunning) {
    for (shotRunning = !0; shotQueue.length; )
      await shotQueue.shift()().catch(() => {
      }), await new Promise((r) => setTimeout(r, 600));
    shotRunning = !1;
  }
}
async function takeScreenshot(opts = {}) {
  await reevaluate();
  let s = await getState();
  if (s.mode === "inactive" || s.terminal || s.targetTabId == null) {
    await notify("Not armed: nothing was captured.", "warn");
    return;
  }
  if (s.privacy || s.manual || s.afk) {
    await systemEvent("Screenshot not captured", "The approved target was not the active, ready tab (or capture was paused)."), await notify("Screenshot not captured: the approved target is not the active tab or capture is paused.", "warn");
    return;
  }
  let settings = await getSettings(), sid = s.sessionId ?? s.shotSessionId;
  sid || (sid = (await createSession("screenshot", s, Date.now(), settings)).id, await dispatch({ type: "SET_SHOT_SESSION", sessionId: sid }), await copyRingEvents(sid, Date.now() - Math.min(settings.replaySec, 60) * 1e3, Date.now()));
  let sessionId = sid, tabId = s.targetTabId, windowId = s.targetWindowId;
  shotQueue.push(async () => {
    try {
      let tab = await chrome.tabs.get(tabId), origins = await approved(s), url = minimizeUrl(tab.url);
      if (!tab.active || url && !isApprovedOrigin(url.origin, origins)) throw new Error("target no longer the active approved tab");
      let id = uid("shot_"), file = `shots/${id}.png`, bytes = 0, viewport = tab.width && tab.height ? { width: tab.width, height: tab.height } : null;
      if (s.mode !== "screenshot_only" && await hasOffscreen()) {
        let r = await sendOff({ kind: "off", op: "screenshot", file });
        if (r?.ok)
          bytes = r.bytes ?? 0, r.width && r.height && (viewport = { width: r.width, height: r.height });
        else {
          let dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" }).catch(() => null);
          if (!dataUrl) throw new Error(r?.error ?? "frame grab failed");
          let blob = await (await fetch(dataUrl)).blob();
          await opfsWrite(file, blob), bytes = blob.size;
        }
      } else {
        let dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" }), blob = await (await fetch(dataUrl)).blob();
        await opfsWrite(file, blob), bytes = blob.size;
      }
      let item = {
        id,
        sessionId,
        ts: Date.now(),
        origin: url?.origin ?? s.targetOrigin,
        path: url?.path ?? null,
        title: null,
        browser: browserName(),
        viewport,
        captureMode: s.mode,
        markerOrdinal: opts.markerOrdinal,
        bytes,
        file,
        annotations: []
      };
      if (await dbPut("shots", item), await recordEvent({ type: "screenshot", evidenceId: id, label: opts.markerOrdinal ? `Screenshot (Marker ${opts.markerOrdinal})` : "Screenshot", sessionId }), opts.markerEventKey != null) {
        let ev = await dbGet("events", opts.markerEventKey);
        ev && await dbPut("events", { ...ev, evidenceId: id });
      }
    } catch (err) {
      await recordEvent({ type: "system", label: "Screenshot failed", note: err instanceof Error ? err.message : String(err), system: !0, sessionId }), await notify("Screenshot failed: " + (err instanceof Error ? err.message : String(err)), "error");
    }
  }), drainShots();
}
async function addMarker(label) {
  let s = await getState();
  if (!s.sessionId || s.terminal) {
    await notify("Markers belong to a session: start a Repro Session first.", "warn");
    return;
  }
  let settings = await getSettings(), ordinal = s.markerCount + 1;
  await dispatch({ type: "MARKER_ADDED" });
  let key = await recordEvent({ type: "marker", label: label?.trim() || `Marker ${ordinal}`, ordinal, sessionId: s.sessionId });
  settings.markerScreenshot && takeScreenshot({ markerOrdinal: ordinal, markerEventKey: key });
}
function onPort(port) {
  if (!isOwnContentScript(port.sender, chrome.runtime.id)) return;
  let tabId = port.sender.tab.id;
  if (port.name === FRAME_PORT_NAME) {
    port.onMessage.addListener((msg) => {
      serial(() => onFrameMessage(tabId, msg));
    });
    return;
  }
  port.name === PORT_NAME && (ports.set(tabId, { port, origin: null, helloAt: 0, seenAt: 0 }), port.onMessage.addListener((msg) => {
    serial(() => onContentMessage(tabId, port, msg));
  }), port.onDisconnect.addListener(() => {
    ports.get(tabId)?.port === port && ports.delete(tabId), serial(reevaluate);
  }));
}
async function onFrameMessage(tabId, msg) {
  if (msg.t !== "event") return;
  let s = await getState();
  if (s.targetTabId !== tabId || !collectingSemantics(s)) return;
  let origins = await approved(s);
  !msg.ev.origin || !isApprovedOrigin(msg.ev.origin, origins) || await recordEvent({ ...msg.ev, tabId, frame: !0 }, s);
}
async function onContentMessage(tabId, port, msg) {
  let s = await getState();
  if (s.targetTabId !== tabId) return;
  let info = ports.get(tabId);
  if (msg.t === "hello") {
    info ? (info.origin = msg.origin, info.helloAt = Date.now(), info.seenAt = Date.now()) : ports.set(tabId, { port, origin: msg.origin, helloAt: Date.now(), seenAt: Date.now() }), await reevaluate();
    return;
  }
  if (msg.t === "ping") {
    info && (info.seenAt = Date.now()), s.privacy && await reevaluate();
    return;
  }
  if (msg.t === "bye") {
    info && (info.seenAt = 0), await reevaluate();
    return;
  }
  if (info && (info.seenAt = Date.now()), msg.t === "event") {
    if (!collectingSemantics(s)) return;
    let origins = await approved(s);
    if (msg.ev.origin && !isApprovedOrigin(msg.ev.origin, origins)) return;
    await recordEvent({ ...msg.ev, tabId }, s);
  }
}
async function onOffscreenEvent(m) {
  let s = await getState();
  if (m.ev === "started")
    await systemEvent("Video capture started", `${m.codec} ${m.width}x${m.height}`);
  else if (m.ev === "ended") {
    if (s.mode === "inactive" || s.terminal) return;
    let tab = s.targetTabId != null ? await chrome.tabs.get(s.targetTabId).catch(() => null) : null;
    await dispatch(tab ? { type: "ERROR", reason: m.reason } : { type: "TARGET_ENDED", reason: "Target tab closed or crashed" });
  } else if (m.ev === "error") {
    if (s.mode === "inactive" || s.terminal) return;
    await dispatch({ type: "ERROR", reason: m.reason });
  }
}
async function onTabRemoved(tabId) {
  ports.delete(tabId);
  let s = await getState();
  s.targetTabId === tabId && s.mode !== "inactive" && !s.terminal && await dispatch({ type: "TARGET_ENDED", reason: "Target tab closed" });
}
async function onTabUpdated(tabId, info) {
  let s = await getState();
  s.targetTabId !== tabId || s.mode === "inactive" || s.terminal || (info.status === "complete" && await injectContent(tabId), await reevaluate(), recheckTimer && clearTimeout(recheckTimer), recheckTimer = setTimeout(() => {
    serial(reevaluate);
  }, LIVENESS_MS + 200));
}
var recheckTimer = null;
async function onIdleState(state) {
  let s = await getState();
  s.mode === "inactive" || s.terminal || (await getSettings()).afkMinutes === 0 || (state === "locked" || state === "idle" ? await dispatch({ type: "AFK_ENTER" }) : (await dispatch({ type: "AFK_EXIT" })).afk || await reevaluate());
}
async function resumeFromAfk() {
  await dispatch({ type: "RESUME_FROM_AFK" }), await reevaluate();
}
async function enforcePolicyNow() {
  let s = await getState();
  if (s.mode === "inactive" || s.terminal || !s.targetOrigin) return;
  let verdict = evaluateTarget(s.targetOrigin, await getPolicy());
  verdict.ok || (await systemEvent("Stopped by organization policy", verdict.message), await disarm(), await notify(`ReproDesk was disarmed: ${verdict.message}`, "warn"));
}
async function enforceRetention(force = !1) {
  let policy = await getPolicy();
  if (policy.sessionRetentionDays <= 0) return 0;
  let last = (await chrome.storage.session.get("retentionAt")).retentionAt ?? 0;
  if (!force && Date.now() - last < 36e5) return 0;
  await chrome.storage.session.set({ retentionAt: Date.now() });
  let s = await getState(), live = new Set([s.sessionId, s.shotSessionId].filter((x) => !!x)), expired = selectExpired(await dbGetAll("sessions"), Date.now(), policy.sessionRetentionDays).filter((x) => !live.has(x.id));
  for (let rec of expired) await deleteSession(rec.id);
  return expired.length;
}
async function tick() {
  let s = await getState(), settings = await getSettings();
  if (await enforcePolicyNow(), await enforceRetention(), await cleanupRingEvents(settings), s.mode === "inactive" || s.terminal) {
    await cleanupRing(Date.now(), settings.replaySec * 1e3 + 15e3);
    return;
  }
  if (s.mode !== "screenshot_only") {
    if (!await hasOffscreen()) {
      await dispatch({ type: "ERROR", reason: "The capture document disappeared (browser or extension interrupted capture)." });
      return;
    }
    if (collecting(s)) {
      let h = await dbGet("journal", "health");
      (!h || Date.now() - h.at > 2e4) && await dispatch({ type: "ERROR", reason: "The capture pipeline stopped responding (no heartbeat)." });
    }
    await reevaluate();
  }
}
async function recover() {
  let s = await getState(), sessions = await dbGetAll("sessions"), now = Date.now();
  for (let rec of sessions) {
    let live = s.mode !== "inactive" && (s.sessionId === rec.id || s.shotSessionId === rec.id);
    if (rec.status === "active" && !live) {
      let segs = await segmentsOfSession(rec.id), lastCommit = segs.length ? Math.max(...segs.map((x) => x.endWall)) : rec.lastCommittedAt;
      await dbPut("sessions", { ...rec, status: "recovered", endedAt: rec.endedAt ?? lastCommit ?? now, lastCommittedAt: lastCommit, endReason: "Recording ended unexpectedly (browser, extension or capture document interrupted)." }), await recordEvent({ type: "system", label: "Recorder interrupted", note: "Recovered from the last committed evidence.", system: !0, ts: lastCommit ?? now, sessionId: rec.id });
    }
    rec.status === "recovered" && !rec.reviewedAt && now - rec.createdAt > RECOVERED_RETENTION_MS && await deleteSession(rec.id);
  }
  let j = await dbGet("journal", "current");
  j && !(s.mode !== "inactive" && (s.sessionId === j.sessionId || s.shotSessionId === j.sessionId)) && await dbDelete("journal", "current"), await refreshBadge(s), await enforceRetention(!0);
}
async function deleteSession(id) {
  let shots = await dbIndexAll("shots", "sessionId", id);
  for (let sh of shots) await opfsRemove(sh.file);
  await dbDeleteWhereSession("shots", id), await dbDeleteWhereSession("events", id), await dbDeleteWhereSession("reports", id), await unpinSession(id), await dbDelete("sessions", id);
}

// src/background/index.ts
chrome.action.onClicked.addListener((tab) => {
  tab.id != null && chrome.sidePanel.open({ tabId: tab.id }).catch(() => {
  }), serial(() => armFromTab(tab));
});
chrome.runtime.onConnect.addListener(onPort);
chrome.tabs.onRemoved.addListener((tabId) => {
  serial(() => onTabRemoved(tabId));
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  serial(() => onTabUpdated(tabId, info));
});
chrome.tabs.onActivated.addListener(() => {
  serial(reevaluate);
});
chrome.windows.onRemoved.addListener(() => {
  serial(reevaluate);
});
chrome.idle.onStateChanged.addListener((st) => {
  serial(() => onIdleState(st));
});
chrome.alarms.onAlarm.addListener((a) => {
  a.name === "tick" && serial(tick);
});
chrome.commands.onCommand.addListener((command) => {
  serial(async () => {
    let s = await getState();
    command === "save-last-replay" ? await saveReplay() : command === "add-marker" ? await addMarker() : command === "take-screenshot" ? await takeScreenshot() : command === "toggle-repro" && (s.sessionId ? await (s.mode === "repro" ? finishRepro() : finishShotSession()) : await startRepro());
  });
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isOwnExtensionPage(sender, chrome.runtime.id, chrome.runtime.getURL(""))) return !1;
  let m = msg;
  if (m?.kind === "cmd") {
    let c = msg;
    return serial(async () => {
      switch (c.cmd) {
        case "saveReplay":
          return saveReplay();
        case "startRepro":
          return startRepro(!!c.payload?.afkOverride);
        // the panel buttons say "Finish & review" / "... & open report": they always open the report
        case "finishRepro":
          return (await getState()).mode === "repro" ? finishRepro({ openReport: !0 }) : finishShotSession({ openReport: !0 });
        case "finishShotSession":
          return finishShotSession({ openReport: !0 });
        case "marker":
          return addMarker(c.payload?.label);
        case "screenshot":
          return takeScreenshot();
        case "manualPause":
          await dispatch({ type: "MANUAL_PAUSE" });
          return;
        case "manualResume":
          await dispatch({ type: "MANUAL_RESUME" }), await reevaluate();
          return;
        case "resumeFromAfk":
          return resumeFromAfk();
        case "disarm":
          return disarm();
        case "ackTerminal":
          await dispatch({ type: "DISARM" });
          return;
        case "openReview":
          return openReview(String(c.payload?.sessionId));
        case "siteRemembered":
          return registerRememberedSite(String(c.payload?.origin));
      }
    }).then(() => sendResponse({ ok: !0 }), (e) => sendResponse({ ok: !1, error: String(e) })), !0;
  }
  return m?.kind === "off-event" ? (serial(() => onOffscreenEvent(msg)), !1) : m?.kind === "delete-session" ? (serial(() => deleteSession(String(msg.id))).then(() => sendResponse({ ok: !0 })), !0) : !1;
});
async function registerRememberedSite(origin) {
  if (!isRememberableOrigin(origin)) throw new Error("Not a plain http(s) origin");
  if (!await chrome.permissions.contains({ origins: [`${origin}/*`] })) throw new Error("Host access for this origin was not granted");
  let id = "rd-" + origin.replace(/[^a-z0-9]/gi, "_");
  (await chrome.scripting.getRegisteredContentScripts({ ids: [id] })).length || await chrome.scripting.registerContentScripts([{ id, matches: [`${origin}/*`], js: ["content.js"], runAt: "document_start", allFrames: !0, persistAcrossSessions: !0 }]);
  let s = await getSettings();
  s.approvedOrigins.includes(origin) || await saveSettings({ approvedOrigins: [...s.approvedOrigins, origin] });
  let st = await getState();
  st.targetTabId != null && await injectContent(st.targetTabId), await notify(`Site remembered: ${origin}`, "info");
}
var applySettingsChange = () => {
  serial(async () => {
    let next = await getSettings();
    await enforcePolicyNow(), (await getState()).mode !== "inactive" && (await chrome.idle.setDetectionInterval(Math.max(15, (next.afkMinutes || 10) * 60)), await chrome.runtime.sendMessage({ kind: "off", op: "config", settings: next }).catch(() => {
    }));
  });
};
chrome.storage.onChanged.addListener((changes, area) => {
  area === "local" && changes.settings && applySettingsChange();
});
onPolicyChanged(applySettingsChange);
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: !1 }).catch(() => {
  }), navigator.storage.persist?.(), serial(recover);
});
chrome.runtime.onStartup.addListener(() => {
  serial(recover);
});
serial(async () => {
  await recover(), await refreshBadge();
});
var BOOT = Date.now();
chrome.storage.session.get("swStarts").then((r) => chrome.storage.session.set({ swStarts: (r.swStarts ?? 0) + 1, swLastStart: BOOT }));
