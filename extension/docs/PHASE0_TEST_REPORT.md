# ReproDesk Phase 0 - verification report

Build under test: `reprodesk-extension` 0.0.1 (release build, no test hook), Chromium 141 (Playwright 1.56 build), Linux, headed under Xvfb + openbox.
Date of the runs: 2026-10-07. Raw data: `docs/phase0-results/` (screenshots, CSV time series, JSON results).

**What this report is not:** official Google Chrome on your machine, Windows/macOS, a managed enterprise profile, or your real application. See "Not verified".

## Scoreboard

| Layer | Checks | Result |
|---|---|---|
| TypeScript typecheck + Vitest | 41 unit tests | all pass |
| Headless e2e (Playwright, test hook, `--allowlisted-extension-id`) | 34 + 16 + 7 | all pass |
| **Real browser**: flow (genuine toolbar click, xdotool mouse/keyboard, shortcuts) | 14 | all pass |
| Real browser: lifecycle (real idle, SW stop, OS window overlay, navigation) | 19 | all pass |
| Real browser: Screenshot-only | 11 | all pass |
| Real browser: Remember this site (genuine Chrome permission prompt) | 10 | all pass |
| Real browser: popup / Active Video Target re-arm | 7 | all pass |
| Real browser: complex pages (WebGL, canvas, iframes, Shadow DOM, 200k-row grid) | 14 | all pass |
| Soak: 40 min Armed, 30 s window | 11 | all pass |
| Soak: 31 min Repro Session with 4 privacy pauses + 9 markers | 11 | all pass* |

\* One check of the first 31-minute run reported ffmpeg "non monotonically increasing dts to muxer" warnings. They are the null muxer re-timing a millisecond-resolution
variable-frame-rate WebM, not corruption: all 25 108 packets decode to 25 108 frames with strictly increasing timestamps, 851 keyframes (= 851 GOP segments), zero
decoder errors. The check now asserts exactly that (decoder errors = 0, frame count, monotonic timestamps), and the figures below come from that run.

## Soak results

**Armed, 40 min, replay window 30 s, animated page** (`soak/armed-timeseries.csv`):
* ring held 16-20 GOP segments (max 0.7 MB) for the whole run; OPFS file count always equalled the index (0 orphans except transient 2)
* storage usage 1 -> 2 MB (slope 0.04 MB/min), offscreen JS heap flat at 4.6-5.0 MB, 0 dropped frames, average CPU of the entire browser 0.73 core
* browser RSS: 1584 MB at start, 1872 MB after 3.6 min, then 1878 -> 1900 MB over the next 37 min (~0.75 MB/min). Not explained; the slope is inside the test limit, but it is the one number to watch on a real 8 h day
* media written: 38 MB in 40 min (extrapolated ~0.4 GB per 8 h on this animated page); "Save Last Replay" after 40 min produced a 32.4 s replay (window + tail + GOP slack)

**Repro Session, 31.4 min, 4 privacy pauses of ~40 s, 9 markers** (`soak/repro-timeseries.csv`):
* 851 GOP segments pinned, 28.0 MB (0.90 MB/min); exported Evidence Package 28.5 MB; ffprobe duration 31.4 min; end of the video seekable
* 4 capture gaps listed in `manifest.json`, 4 "Privacy Pause start" system events, 9 markers
* CPU 0.74 core average, browser RSS 1587 -> 1912 MB (warm-up), storage growth 0.99 MB/min (= the evidence itself), 0 orphans

## Complex pages (B0.13) - pixels vs DOM

Fixture: WebGL (software), 2D canvas chart, same-origin iframe, cross-origin iframe, open Shadow DOM button, 200 000-row virtualised grid, 25 DOM updates/s.

| Evidence | In the video | In DOM semantics |
|---|---|---|
| WebGL content | yes (colours found in decoded frames) | only "canvas" click, no content |
| 2D canvas chart | yes | only "canvas" click |
| Same-origin iframe | yes | yes (button label, `frame: true`) |
| Cross-origin iframe | yes | no, by policy (origin not approved); nothing stored for that origin |
| Shadow DOM button | yes | yes (label "Shadow action") |
| Virtualised grid row | yes | yes, order number redacted (`Order #[redacted]`) |

Cost on that heavy 1080p page: browser CPU 2.2 -> 3.3 cores armed (software WebGL dominates; capture adds roughly 1 core), 0 dropped frames, tree RSS ~1.4 GB.
On a light animated page the whole browser used 0.73 core with capture on. The captured video is 1920x1080 with the tab scaled into it (bars on the sides for
smaller windows); capturing at native tab size is a tuning item.

## Defects the real-browser suites found (all fixed)

1. Fail-open on same-site navigation (bfcache keeps the old page's extension port open) - capture stayed armed on the new page. Now page heartbeat + `pagehide` + URL check; tested with an origin change on the same host.
2. "Start/finish Repro Session" shortcut silently had no key (Chrome allows 3 suggested keys). Documented, no default.
3. Icon click on an already armed tab was a no-op, so a lost `activeTab` could not be recovered. It now re-validates the page.
4. Shadow DOM and approved-origin iframes were invisible to semantics; large containers produced giant labels. Fixed.
5. (Harness, not product) tab ordering after closing a temporary tab left the probe tab active, which correctly kept Privacy Pause on; the soak now re-activates the tested tab.

## Observations worth knowing

* Chrome shows its own capture indicator on the tab while recording (`docs/phase0-results/screenshots/01-armed.png`).
* The permission prompt for "Remember this site" says "Read and change your data on localhost" (`40-permission-prompt.png`); it is requested only on the user's click and only for one origin.
* `activeTab` survived a same-origin full-page navigation here but not a cross-origin one; recovery is the icon click or "Remember this site".
* Chromium's open-source build has no H.264 encoder (`avc1` unsupported); VP9, VP8 and AV1 are available. Official Chrome normally has H.264 - check Diagnostics on your machine before deciding on MP4.
* The 30 s keep-alive alarm and the open content-script port mean Chrome rarely idles the service worker while Armed; recovery after a forced stop works (tested).

## Not verified (needs you)

Official Google Chrome; Windows/macOS screen lock and native notifications; managed enterprise policies; Edge; your real application and SSO flows (practicesoftwaretesting.com
is unreachable from the sandbox); a real 8-hour workday; users' acceptance of the capture indicator; developer preference of pixels+semantics over DOM replay.
