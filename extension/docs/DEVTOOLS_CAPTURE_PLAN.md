# Console & network log ("DevTools capture") - research, plan and implementation

Status: **implemented in the Phase 0 build** (opt-in, off by default). This document records how competitors do it, what we chose and why,
what exactly is collected and filtered, and what is left for later.

## 1. Goal

A developer who opens a ReproDesk report should see what the browser's DevTools would have shown at the moment of the bug: console
errors, uncaught exceptions and the requests that failed, on the same clock as the replay. ReproDesk's promises stay intact: local only,
explicit consent, nothing typed is collected, nothing leaves the device before export, and the administrator stays in control.

## 2. How competitors do it

Checked October 2026 against public documentation and the published Chrome Web Store packages (manifests and bundles were read, nothing was run).

| Product | How console / network is captured | Bodies / headers | Redaction | Look-back |
|---|---|---|---|---|
| **Jam** | Page-world (MAIN) scripts registered at `document_start` on all sites wrap `console.*`, `fetch`, XHR, WebSocket; `webRequest` as well. No `debugger` permission. | Yes, bodies of XHR/fetch (not binary, not over 1 MB in the SDK) | Client-side scan of headers and JSON bodies for tokens, cookies, PII ("JAM_DOES_NOT_SAVE_SECRETS"); over-redacts on purpose | Instant Replay: a local, rolling 2-minute DOM buffer, opt-in |
| **BetterBugs** | MAIN-world `document_start` script (console, fetch, XHR, unhandledrejection) + `webRequest` for other types; also cookies and storage | Yes | 10 default regex patterns (password, API key, card, CVV, email, Bearer/JWT, client id, IPv4/6) on the stringified data, with a preview | Rewind: last 2 min, off by default, per site |
| **BrowserStack Bug Capture** | Injected page scripts wrap `fetch`/XHR and console; `webRequest` for all other request types (documented) | Response bodies for JSON/text only, 1 MB default cap; no WebSocket | Authorization, "password", "Bearer", token values; workspace regex rules | Replays: last 2 min, per page, local until upload |
| **Marker.io** | The widget script (the extension only injects it): fetch/XHR + Resource Timing for images, scripts, CSS | Headers and bodies | Exclusion by key in headers/JSON bodies | Server-side replay buffer |
| **Userback** | Widget only; the extension captures **no** console or network | Network optional, off by default in Full Session Replay | DOM masking only | - |
| OpenReplay / LogRocket (SDKs) | Patch `fetch`/XHR (or Proxy), console methods, resource timing | Payload capture **off** by default (OpenReplay); `Cookie`, `Set-Cookie`, `Authorization` ignored by default | Sanitizer hooks | Session recording |

Takeaways:

* **Nobody uses `chrome.debugger`.** It would show the "started debugging this browser" bar for as long as capture runs, adds the
  "Access the page debugger backend" install warning and can be blocked by enterprise policy. For an always-on rolling buffer it is a non-starter.
* The common pattern is a **page-world script** wrapping `console`, `fetch` and XHR, plus **Resource Timing** (or `webRequest`) for everything else.
* The norm for look-back is **about 2 minutes**, kept locally, with client-side redaction. Several products capture bodies; the privacy-minded
  SDKs keep them off by default.

## 3. Options and the choice

| Option | Pros | Cons | Decision |
|---|---|---|---|
| Page-world (MAIN) script wrapping `console`, `onerror`, `unhandledrejection`, `fetch`, XHR | No new permission, no infobar, exact timings, works with the rolling buffer | The page can see and tamper with it; misses workers / service workers; DevTools may show it as the source line of the page's messages | **Chosen** |
| `PerformanceObserver` (`resource`, `navigation`, `buffered: true`) | Covers scripts, styles, images, beacons and the document itself, **including what loaded before the recorder arrived**; `responseStatus` since Chrome 109 | No method, no headers; status 0 for cross-origin without TAO | **Chosen** as the complement |
| `chrome.debugger` + CDP | Everything, including bodies and WebSocket frames | Infobar all the time, scary install warning, policy-blockable | Rejected (maybe an explicit one-off "deep capture" later) |
| `chrome.webRequest` | Sees every request type | Needs host permissions for all sites (we use `activeTab`), no response bodies, duplicates Resource Timing | Not needed now |

## 4. Design (what is built)

### 4.1 Capture

* `src/pagelog/index.ts` -> `dist/pagelog.js`, runs in the page's own world (`world: 'MAIN'`). It only observes: every original function is
  called unchanged and nothing is blocked. It records:
  * `console.error / warn / log / info / debug / trace` and failed `console.assert`, as text (objects are stringified with a key budget and
    cycle guard; DOM nodes become `<tag#id.class>`, never their text or value);
  * uncaught exceptions (`error` event) and unhandled promise rejections, with the stack;
  * `fetch` and XHR: method, URL, status, time to response headers, `content-length`, or `failed` / `aborted` / `timeout`;
  * everything else from Resource Timing (scripts, styles, images, beacons, the document), and fetch / XHR made **before** the recorder arrived.
* **Injection** (only while armed on an approved target with the log on):
  * `chrome.scripting.executeScript({ world: 'MAIN', injectImmediately: true })` when arming, when the log is switched on during capture,
    when the target starts loading a new document (`status: loading`) and again when it is complete (guarded, so twice is harmless);
  * where the user granted host access ("Remember this site"), it is also **registered at `document_start`** for the approved origins while
    capture runs, so a reload is covered from its first line; unregistered on disarm, when the log is switched off or the policy forbids it.
    With `activeTab` alone the very first console lines of a reload can be missed (requests are still recovered from Resource Timing).
* **Relay**: the page recorder batches entries (250 ms, or right away in bursts of 100) and dispatches them as **JSON text** on a DOM event; the
  isolated content script relays them to the service worker over its existing port. A ping/pull handshake works in either load order. The page
  queue is capped at 500 entries; what it has to drop is counted and reported.

### 4.2 What is kept, and how it is filtered

All filtering happens in the service worker **before anything is stored** (`src/shared/devlog.ts`, pure and unit-tested):

* **Gate**: semantics are being collected (not Privacy / Manual / AFK paused, not ended), the log is on (user or policy), the origin is approved.
* **Time window**: nothing from before arming or before the log was switched on, nothing older than 60 s on arrival, nothing from the future.
  Kept entries share the replay's lifecycle: ring while Armed (same window as the video), pinned on save, cut ranges and Pre-session Context
  apply, deleted with the session and by retention.
* **Never collected**: request or response bodies, headers, cookies, storage, query **values**, URL fragments, WebSocket frames.
* **URLs**: origin + path; id- and token-looking path segments masked (`:id`, `:token`), emails in paths redacted; query parameter **names** kept,
  values replaced by `…`; `data:` / `blob:` reduced to the scheme.
* **Text** (messages and stacks): URLs inside lose their query; then fixed patterns are redacted - JWTs, `Bearer|Basic|Token …`, secret
  key/value pairs (`password`, `token`, `api_key`, `authorization`, `session_id`, `cookie`, `secret`, `otp`, `pin`, `cvv`, … in `k=v`, `k: v`
  and JSON forms), emails, Luhn-valid card numbers, 32+ character mixed tokens (bundle hashes in file names stay readable). The rule set is
  versioned (`devlog-patterns-v1`) and written into the manifest.
* **Bounds**: message 1 000 characters, 8 stack frames / 1 500 characters, URL 400 characters, 200 entries per batch, **1 200 entries per
  minute** (anything over is dropped and a system event "Console & network log limit reached" says how many).

### 4.3 Settings and policy

* Side panel -> Settings -> Capture: **Console & network log**, off by default.
* Policy `ConsoleNetworkLog` (boolean): `true` = always recorded, `false` = never; either way locked for the user and listed in the
  "Managed by your organization" banner. See `ADMIN_POLICY.md`.

### 4.4 Review

* The **timeline** shows console errors, uncaught errors, rejections and failed requests (status >= 400 or no answer) next to the clicks and
  navigations; ordinary messages stay out of it. Steps to reproduce are never drafted from log entries.
* A **Console & network** panel: Console / Network tabs with counts and error badges, "Problems only", status / level badges, method, URL,
  type, duration and size; clicking a row moves the replay to that moment.

### 4.5 Exports

* Export card switch **Console & network log** (on when the session has a log). Off = nothing of the log in any format.
* HTML: a "Console & network" section (summary, problems, collapsible full tables). TXT / Markdown / DOCX: "Console errors and failed
  requests". XLSX: `Console` and `Network` sheets.
* ZIP Evidence Package: `console.json`, `network.har` (HAR 1.2: opens in Chrome DevTools -> Network -> Import HAR; headers / cookies empty,
  query values `…`), the log is out of `events.json`, and the manifest gets `console_network_log` (counts, rule version, what is never collected)
  plus SHA-256 entries for both files.

### 4.6 Trust model

* The page recorder lives in the page's world: the page can see the relay events and could forge entries, exactly as it can write anything to its
  own console. Entries are therefore treated as **untrusted page data**: shape-checked, filtered, bounded, rate-limited, and escaped in every
  renderer (HTML, Markdown, XLSX, DOCX). They never drive extension behaviour.
* The recorder adds no new permission and no install warning; it runs only on approved origins while armed with the log on.
* Like Jam, DevTools may attribute the page's own console lines to `pagelog.js`; Chrome's ignore list (DevTools -> Settings -> Ignore list)
  hides it. Shipping a source map with `x_google_ignoreList` would need the map to be web-accessible, which makes the extension detectable by
  pages, so it was left out.

## 5. Tests

* Unit (`tests/unit/devlog.test.ts`, `report.test.ts`, `policy.test.ts`): redaction patterns (including what must stay readable), URL
  cleaning, raw-entry validation and time windows, problem classification, the per-minute budget and recorder drop counts, HAR shape, report
  model and every renderer, ZIP contents and manifest hashes, the policy key.
* E2E (`tests/e2e/devlog.mjs`, 39 checks incl. an axe audit of the new panel, part of `npm run test:e2e`): off by default (not injected, not registered, nothing kept);
  switching on mid-capture; console levels, secret redaction, uncaught error with stack, rejection, fetch 500 / POST / XHR 404 / unreachable
  host, a reused XHR object; query values, fragments, bodies and secrets never stored; reload covered (document request + new messages); Review panel, timeline rows,
  filter, seek; ZIP / HTML / TXT with the log and without it; policy off; flood cap with its system note; registration removed on disarm.

## 6. Not yet / next steps

| Item | Why it matters | Proposal |
|---|---|---|
| Request / response bodies | Developers often want the JSON error body | Opt-in by policy only, JSON / text only, 64 KB cap, key-based redaction before storage, a redaction preview before export |
| GraphQL errors | They arrive as HTTP 200 | Needs response bodies (above): flag `errors[]` in JSON responses |
| WebSocket | Real-time apps | Wrap `WebSocket`, text frames only, bounded and redacted like console text |
| Worker / service-worker requests | Invisible to page-world wrappers | Resource Timing in workers is not reachable; `webRequest` would need broad host permissions - revisit with customers |
| Early console lines on reload with `activeTab` only | First lines of a load can be missed | "Remember this site" already fixes it (registered at `document_start`); document it in the user guide |
| Admin-defined redaction rules | Company-specific ids and tokens | Policy `ConsoleNetworkRedactPatterns` (regex list, validated by `gen-policy`) |
| Redaction preview | Trust before sharing | Show the filtered log with highlights in the export card |
| Official Chrome / Edge | Phase 0 ran on Chromium only | Same manual checks as the rest of Phase 0 |
