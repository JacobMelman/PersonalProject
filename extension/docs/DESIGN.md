# ReproDesk - design notes

**Personality:** calm, precise, trustworthy. A QA tool that handles sensitive data should look like a well-made instrument, not a screen recorder. Indigo brand, a coral record dot,
generous whitespace, one primary action per screen state.

## System
* **Tokens** live in `public/styles.css` (`:root` + dark override). Light and dark follow the OS. Colours: ink/indigo brand, and one semantic hue per capture state
  (green Armed, red REC/error, amber paused, violet AFK, blue Screenshot-only).
* **Type:** Inter (variable, bundled - no network), tabular numerals for every time/size. Scale 11 / 12 / 13 / 15 / 24-30.
* **Icons:** Lucide (ISC), bundled as SVG text (`src/ui/icons.ts`), always paired with a text label.
* **Brand mark:** `src/ui/brand.ts` and `scripts/gen-icons.mjs` (white replay ring + coral record dot on an indigo tile; also the toolbar icons).
* **Motion:** a single pulse on the live state badge; everything honours `prefers-reduced-motion`.

## Principles
1. **State is never colour-only.** Every state has an icon, a small-caps label (`ARMED`, `REC`, `PRIVACY PAUSED`, `AFK`, ...), a headline and a sentence.
2. **Show the guarantee.** Three trust chips (Local only / No keystrokes / This tab only) sit under the status card; the Review page opens with an explicit "check before sharing" callout.
3. **The buffer is visible.** A 30-tick meter shows how much of the rolling window is filled, so "Save last replay" is never a leap of faith.
4. **One primary action.** Armed -> Save last replay. Recording -> Add marker. Paused -> Resume. Everything else is secondary or ghost.
5. **Evidence first.** Review leads with the player, a live-following timeline and screenshots; the report form and export sit beside it, not in front of it.

## Surfaces
| Surface | File |
|---|---|
| Side panel (360 px) | `src/sidepanel/index.ts` |
| Review + session list | `src/review/index.ts` |
| Exported HTML report (self-contained, light/dark/print) | `src/report/render-html.ts` |
| Thumbnails (screenshot or decoded video frame) | `src/report/thumb.ts` |
| Demo shop used for presentations | `demo-app/`, `scripts/demo-app.template.html` |

Screenshots of every state are in `docs/demo/` (regenerate with `npm run demo:shoot`).

## Privacy tools and accessibility (v0.3)

* **Screenshot editor** - full-screen overlay on the Review page: tool rail (select, arrow, line, rectangle, ellipse, text, blur, black box), colour swatches, undo/redo/delete/revert. Everything is non-destructive; the footer states that Blur and Redact remove the pixels from every exported copy.
* **Privacy tools card** - sits directly under the player: *Mask a region* (drag on the video, then Blur or Black box and a time range), *Cut out a range*, *Preview redacted*. Active masks are drawn as dashed amber boxes over the live video (blur masks use a conservative backdrop blur so nothing looks hidden that is not); the preview button swaps the player to the exact export copy and labels it.
* **Sample sessions** carry a *Sample* badge in the panel and in the session grid, and a banner on the Review page.
* **Colour tokens for text** - plain `--green/--amber/--red/--blue/--brand` stay for icons and fills; text on tinted badges, pills and danger buttons uses the `*-ink` variants so every pair meets WCAG AA in both themes. Secondary text (`--text-3`) is at least 4.5:1 on every surface.
* **Accessibility is tested, not assumed**: `tests/e2e/a11y.mjs` runs axe-core (WCAG 2.1 A/AA + best practice) on the side panel (empty, with sessions, settings), the sessions grid, a session, the privacy tools form and the editor, in light and dark. Serious and critical findings fail the run and CI.
