# ReproDesk - Phase 0 build status (spec v0.2.4)

This is the **Phase 0 engineering-spike build**, not a product release. The table maps every Phase 0 spike of the spec (section 20.1) to what exists in this
repository, what is covered by automated tests, and what still has to be validated by a person on a real machine. "Auto" means a check in
`tests/` that runs in real Chromium (`npm run test:e2e`) or Vitest (`npm test`).

| Spike | What is in the build | Auto-tested | Needs a person / not done |
|---|---|---|---|
| B0.1 MV3 skeleton | Service worker, side panel, content script, offscreen document. Capture state lives in `chrome.storage.session`, evidence in IndexedDB + OPFS. | State machine (unit); state/semantics keep working across an interrupted session (recovery e2e) | Idle termination of the service worker (30 s) could not be forced from Playwright: validate by leaving it Armed for a few minutes with DevTools closed, or stop it at `chrome://serviceworker-internals` |
| B0.2 tabCapture + rolling chunks | `tabCapture` -> `MediaStreamTrackProcessor` -> WebCodecs VP9 (VP8 fallback), 2 s GOP segments in OPFS with an IndexedDB index, wall-clock eviction | Segments are produced; ring only keeps the configured window (30 s + slack) after 40 s; saved replay is a valid VP9 WebM | 90 s default window under real load; CPU/memory numbers (see Diagnostics panel) |
| B0.3 Repro Session | Start / Pause / Resume / Finish, 30 s Pre-session Context pinned as a separate block, markers, screenshots | Start, finish, pre-context, markers, privacy pause/resume | 30+ minute session |
| B0.4 Post-trigger tail | Configurable 0/3/5/10 s tail before the window is frozen and pinned | Tail included in the saved window | Perceived trigger latency (< 250 ms acknowledgement is shown immediately) |
| B0.5 DOM privacy semantics | Click / focus / submit / SPA navigation; label sanitiser; no keyboard, clipboard or editable values; URL = origin + path | Typed password / text never persisted; query string and fragment never persisted; e-mail / card / phone-like text redacted | Review on your own app's DOM for PII in button labels |
| B0.6 Target scope / multi-tab | One approved origin (+ extra approved origins); leaving it pauses everything; unapproved navigation fails closed | Tab switch -> Privacy Pause -> auto resume; navigation to another origin -> pause, no events stored; popup is never silently captured | **Limitation:** semantic events of a related tab are only collected after that tab becomes the Active Video Target (icon click) |
| B0.7 Visible state | Badge text + panel: Inactive / Armed / REC + timer / Screenshots only / Privacy Paused / Paused-manual / AFK / Target Ended / Error. The panel shows an error when the capture heartbeat stops. | Every transition in the reducer (unit) and via e2e | Visual/accessibility review of the panel |
| B0.8 Target-ended recovery | Closing the target tab freezes evidence, adds a system marker, stops capture, opens Review with classification | Yes | Browser crash / window close variants |
| B0.9 Local storage / export | IndexedDB (metadata, journal) + OPFS (media, screenshots); ZIP Evidence Package with versioned manifest + SHA-256 | ZIP contents, hashes, ffprobe of the video | Quota stress, persistence prompts; **container decision:** WebM is the baseline (MediaRecorder-free WebCodecs pipeline); the Diagnostics panel prints whether H.264 encoding exists on the machine, which decides whether an MP4 remux is worth building |
| B0.10 Report renderer model | One Report Model -> HTML, TXT, Markdown, DOCX, XLSX, ZIP | All six formats generated in one export action; LibreOffice opens DOCX and XLSX; HTML escapes user text | Real Word / Excel |
| B0.11 Managed environment | Optional host permissions only; no `debugger`, no `tabs`, no always-on host access | Manifest policy test | **Install on 2 managed machines** |
| B0.12 Advanced Debug Context | Not built (deferred by the spec) | - | - |
| B0.13 Pixel fidelity vs DOM replay | Pixel video + DOM semantics are both recorded | - | Run the canvas/iframe/virtualised-grid pages you care about and compare |
| B0.14 Cross-tab video transition | New tab/popup -> Privacy Pause + explicit re-arm by clicking the icon on that tab; capture gap marked in the timeline | Switch works in the test build (headless uses an allow-list flag instead of a click) | **Real Chrome user-gesture behaviour** |
| B0.15 Recovery Journal | Active sessions that were interrupted reopen as Recovered Session (last committed chunk, system marker, 7-day retention if never opened) | Browser closed mid-session -> Recovered Session, video plays | `kill -9`, power loss |
| B0.16 Visual privacy baseline | Everything stays local until Review; Review warns about visible sensitive data | Warning present | Manual blur/redact/remove is **not built** (Phase 2) |
| B0.17 Video-only permissions | `audio: false`; manifest has no audio/mic/camera permission | Manifest test; exported video has no audio stream | - |
| B0.18 8+ hour Armed endurance | Bounded ring, 5 s cleanup, health counters, storage estimate in Diagnostics | 40 s boundedness | **Run a full workday and send the Diagnostics JSON** |
| B0.19 Active Video Target re-arm UX | Click the icon (or use a shortcut) on the new approved tab | Switch logic | Real-Chrome friction check |
| B0.20 Marker screenshot | Marker is committed first, screenshot follows asynchronously (grabbed from the approved tab stream, 600 ms spacing) | Marker + screenshots stored | Rapid-fire marker stress |
| B0.21 AFK lifecycle | `chrome.idle`: locked -> AFK at once, idle threshold (default 10 min, 5/10/15/30/off), Armed auto-resumes, Repro Session needs explicit Resume, per-session override | State rules (unit), encoder suspension and Armed resume (e2e, using a synthetic idle event) | Real lock/idle transitions |
| B0.22 Screenshot-only | `Video capture` off -> Screenshot-only mode, screenshot sessions, same privacy checks | State rules | `captureVisibleTab` needs a real user gesture (`activeTab`) - validate by hand |
| B0.23 Annotation editor | **Not built** (Phase 2). Screenshots are stored immutable with an empty `annotations` list so the data model is ready. | - | - |

## Differences from the spec worth knowing

* **Video container:** the spec example says `replay.mp4`. This build writes **WebM (VP9/VP8)** because WebCodecs VP9/VP8 encoding is available everywhere and
  keeps pre-trigger trimming exact at GOP level. MP4/H.264 depends on the encoder present on the machine (see Diagnostics). Decision belongs to B0.9.
* **Trim granularity:** Instant Replay windows start at the nearest earlier keyframe (up to ~2 s earlier than requested).
* **Screenshots** in Armed / Repro modes come from the approved tab's own video stream (no extra permission, cannot show another tab); Screenshot-only mode
  uses `chrome.tabs.captureVisibleTab`.
* **Content script scope:** top frame only (iframes are visible in pixels, not in semantics).
* **Not in Phase 0:** custom templates/validation, filename-template locking, multiple Bug Reports per session, manual redaction, annotation editor, Edge packaging.
