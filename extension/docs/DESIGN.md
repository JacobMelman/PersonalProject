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
