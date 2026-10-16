# ReproDesk browser extension - Phase 0 spike build

Privacy-first bug capture for enterprise web QA (Chrome Manifest V3). Implements the Phase 0 engineering spikes of the
*Product Concept & Pre-MVP Specification v0.3* (the revised specification lives in `../docs/`). See `docs/PHASE0_STATUS.md` for what is built, tested and still open, and
`INSTALL.txt` (Russian) for step-by-step installation and a manual validation checklist.

## What it does

* **Instant Replay** - the approved tab is captured into a bounded rolling buffer (default 90 s). *Save Last Replay* pins the window plus a post-trigger tail.
* **Repro Session** - Start / Pause / Resume / Finish, optional 30 s Pre-session Context, named markers with asynchronous screenshots.
* **Screenshot-only** mode, **Privacy Pause**, **AFK**, **Target Ended**, **Recovered Session**, each with an explicit visible state.
* **Review** page: replay with click highlights (a ring where the user clicked, also in the exported video; the recording itself is unchanged), raw timeline, draft steps from observed actions (each can be renamed in the reporter's own words; the observed action stays next to it, also in exports), report fields, export to HTML / TXT / Markdown / DOCX / XLSX / ZIP Evidence Package.
* **Console & network log** (opt-in, off by default): console messages, uncaught errors, rejected promises and request metadata (method, URL without query values, status, timing) of the approved target, recorded on the replay's clock by a page-world script, filtered before storage (secrets, emails, card numbers, tokens; never bodies, headers or cookies). Errors and failed requests appear on the timeline and in every report; the ZIP adds `console.json` and a HAR file for Chrome DevTools. Research and design: `docs/DEVTOOLS_CAPTURE_PLAN.md`.
* **Privacy tools before anything leaves the device** - a screenshot editor (arrow, shapes, text, mosaic blur, black box; non-destructive) and video tools (time-ranged blur / black-box masks, cut-out ranges, exact-export preview). The stored evidence is never modified; the unredacted original is exported only on explicit request.
* **Administrator policies** (managed storage; Group Policy / Intune / MDM / JSON): allowed and blocked sites, fixed capture settings, video off (Screenshot-only), console & network log on / off, export formats and confirmation, no unredacted originals, retention, sample switch. Guide: `docs/ADMIN_POLICY.md`; deployment files: `node scripts/gen-policy.mjs`.
* **Sample sessions** (Settings -> Sample data): a pre-recorded run of the demo shop, labelled and removable, for trying everything without recording.
* Data minimisation by construction: no keyboard events, no clipboard, no editable values, URLs reduced to origin + path, no audio/mic/camera, everything local.

## Design & demo

A bundled design system (Inter, Lucide icons, light/dark, state-aware status card, rolling-buffer meter, live-following timeline, polished exports) is described in `docs/DESIGN.md`.
A presentation kit - demo shop with two deliberate bugs, a talk track (`docs/DEMO_SCRIPT.md`), screenshots and a screen recording of the whole run (`docs/demo/`) - is in the repo:
`npm run demo:site` serves the shop, `npm run demo:shoot` regenerates the screenshots and `npm run demo:film` the narrated walkthrough videos (`docs/demo/reprodesk-demo.mp4` with English voice-over, `reprodesk-demo-subtitles.mp4` with voice-over and YouTube-style captions, `reprodesk-demo.en.srt`; credits in `docs/demo/CREDITS.md`), and `npm run demo:film:devlog` a 2-minute film of the console & network log (`docs/demo/reprodesk-devlog.mp4`).

**Hand-over kit** (`releases/ReproDesk-Phase0-Kit/` and `.zip`, rebuilt by `npm run kit`): the release build of the extension, the demo shop with double-click
launchers for macOS / Windows / Linux (Node.js or Python 3, no `npm install`), the talk track and `INSTALL_AND_RUN.md` (Russian) - everything needed to install and run
ReproDesk on another computer.

## Layout

```
src/background   service worker: state machine side effects, arming, sessions, markers, screenshots, recovery
src/offscreen    tab capture -> WebCodecs encoder -> GOP segments (OPFS + IndexedDB), screenshot grab
src/content      privacy-filtered DOM/navigation collector (top frame only)
src/pagelog      page-world recorder for the opt-in console & network log (filtered in the service worker before storage)
src/sidepanel    controller UI: state, controls, settings, diagnostics
src/review       review + export UI, screenshot editor, privacy tools
src/report       Report Model + renderers (html, txt/md, docx, xlsx) + Evidence Package + WebM muxing + redacted video re-encode
src/demo         sample-session loader (bundle in public/sample)
src/shared       policy (parse/match/enforce rules), state machine, privacy filters, console & network log filters + HAR, ring-buffer rules, types, settings, annotations, video edits, sender/origin validation
src/storage      IndexedDB wrapper, OPFS wrapper, segment storage
tests/unit       Vitest (state machine, privacy filters, ring rules, filenames, report layer)
tests/e2e        Playwright against a local fixture site, real Chromium + real tab capture (flow, exports, recovery, annotate, video-redact, sample, a11y)
scripts          icon/key generation, packaging, demo launcher, sample-bundle recorder, notices generator
```

## Commands

```bash
npm install
npm run build        # release build -> dist/ (load this folder as an unpacked extension)
npm run typecheck
npm test             # unit tests
npm run test:e2e     # builds the E2E variant and runs the Playwright suites (needs Chromium from Playwright 1.56)
npm run test:real    # real-browser suites (headed Chromium under Xvfb, real input) - see below
npm run soak:armed   # 40 min bounded-ring soak            npm run soak:repro   # 31 min Repro Session soak
npm run package      # release build zipped to releases/
npm run policy      # generate deployment files from policy/example-policy.json
npm run notices      # regenerate THIRD_PARTY_NOTICES.md from the real bundle
npm run demo:bundle  # re-record the bundled sample sessions (needs the real-browser rig below)
npm run demo -- --url https://example.com --steps scripts/demo-steps.example.mjs   # dogfood launcher
```

The E2E build differs from the release build only by a test hook in the service worker and host access to `localhost`
(headless Chromium cannot click the toolbar icon, so `--allowlisted-extension-id` plus the hook replace that one user gesture).
Release builds contain no test hook.

Continuous integration (`.github/workflows/extension-ci.yml`): typecheck, unit tests, release build and notices check; headless e2e (including the axe accessibility audit); an experimental real-browser job.

The extension id is stable (`manifest.key.json` holds only the public key) so unpacked installs always get the same id.

## Real-browser suites (`tests/real`)

They launch headed Chromium under Xvfb + openbox and drive it with `xdotool` (real mouse, keyboard, toolbar click) and a raw CDP client attached to page targets only.
Prerequisites on a Linux box: `apt-get install -y xvfb openbox xdotool xterm imagemagick ffmpeg`, `pip install pillow`, Playwright 1.56's Chromium
(`/opt/pw-browsers`) or `CHROME_BIN=/path/to/chrome`. Run suites in parallel by giving each its own `RD_DISPLAY`, `RD_PORT` and `RD_SITE`.
`RD_DIST=/tmp/copy` runs a suite from a copy of `dist/`, so a long soak is not disturbed by a rebuild. `.claude/agents/reprodesk-verifier.md` describes an agent
that runs the whole ladder and reports.
