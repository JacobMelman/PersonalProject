# ReproDesk browser extension - Phase 0 spike build

Privacy-first bug capture for enterprise web QA (Chrome Manifest V3). Implements the Phase 0 engineering spikes of the
*Product Concept & Pre-MVP Specification v0.2.4*. See `docs/PHASE0_STATUS.md` for what is built, tested and still open, and
`INSTALL.txt` (Russian) for step-by-step installation and a manual validation checklist.

## What it does

* **Instant Replay** - the approved tab is captured into a bounded rolling buffer (default 90 s). *Save Last Replay* pins the window plus a post-trigger tail.
* **Repro Session** - Start / Pause / Resume / Finish, optional 30 s Pre-session Context, named markers with asynchronous screenshots.
* **Screenshot-only** mode, **Privacy Pause**, **AFK**, **Target Ended**, **Recovered Session**, each with an explicit visible state.
* **Review** page: replay, raw timeline, draft steps from observed actions, report fields, export to HTML / TXT / Markdown / DOCX / XLSX / ZIP Evidence Package.
* Data minimisation by construction: no keyboard events, no clipboard, no editable values, URLs reduced to origin + path, no audio/mic/camera, everything local.

## Design & demo

A bundled design system (Inter, Lucide icons, light/dark, state-aware status card, rolling-buffer meter, live-following timeline, polished exports) is described in `docs/DESIGN.md`.
A presentation kit - demo shop with two deliberate bugs, a talk track (`docs/DEMO_SCRIPT.md`), screenshots and a screen recording of the whole run (`docs/demo/`) - is in the repo:
`npm run demo:site` serves the shop, `npm run demo:shoot` regenerates all visuals.

## Layout

```
src/background   service worker: state machine side effects, arming, sessions, markers, screenshots, recovery
src/offscreen    tab capture -> WebCodecs encoder -> GOP segments (OPFS + IndexedDB), screenshot grab
src/content      privacy-filtered DOM/navigation collector (top frame only)
src/sidepanel    controller UI: state, controls, settings, diagnostics
src/review       review + export UI
src/report       Report Model + renderers (html, txt/md, docx, xlsx) + Evidence Package + WebM muxing
src/shared       state machine, privacy filters, ring-buffer rules, types, settings
src/storage      IndexedDB wrapper, OPFS wrapper, segment storage
tests/unit       Vitest (state machine, privacy filters, ring rules, filenames, report layer)
tests/e2e        Playwright against a local fixture site, real Chromium + real tab capture
scripts          icon/key generation, packaging, demo launcher
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
npm run demo -- --url https://example.com --steps scripts/demo-steps.example.mjs   # dogfood launcher
```

The E2E build differs from the release build only by a test hook in the service worker and host access to `localhost`
(headless Chromium cannot click the toolbar icon, so `--allowlisted-extension-id` plus the hook replace that one user gesture).
Release builds contain no test hook.

The extension id is stable (`manifest.key.json` holds only the public key) so unpacked installs always get the same id.

## Real-browser suites (`tests/real`)

They launch headed Chromium under Xvfb + openbox and drive it with `xdotool` (real mouse, keyboard, toolbar click) and a raw CDP client attached to page targets only.
Prerequisites on a Linux box: `apt-get install -y xvfb openbox xdotool xterm imagemagick ffmpeg`, `pip install pillow`, Playwright 1.56's Chromium
(`/opt/pw-browsers`) or `CHROME_BIN=/path/to/chrome`. Run suites in parallel by giving each its own `RD_DISPLAY`, `RD_PORT` and `RD_SITE`.
`RD_DIST=/tmp/copy` runs a suite from a copy of `dist/`, so a long soak is not disturbed by a rebuild. `.claude/agents/reprodesk-verifier.md` describes an agent
that runs the whole ladder and reports.
