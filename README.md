# Handoff: Strata — AI Engineering Workspace

## Overview
Strata turns scattered AI-generated Markdown (Claude research, Cursor plans, GitHub docs, prompt recipes) into a searchable, structured engineering knowledge base — usable by humans and, via MCP, by AI agents. This package covers three core screens: Library, Import & Sources, and Document Reader.

## About the Design Files
The files in this bundle (`Vault.dc.html`) are **design references built in HTML** — prototypes showing intended look, structure, and behavior, not production code to copy directly. The task is to **recreate these designs in the target codebase's existing environment** (React, Vue, native, etc.) using its established component patterns and libraries. If no frontend framework exists yet, choose the most appropriate one for the project and implement there.

## Fidelity
**High-fidelity**: final colors, typography, spacing, and layout are intentional and should be recreated pixel-close. Copy/content shown (doc titles, connector names, stats) is placeholder — wire to real data.

## Screens / Views

### 1. Library
- **Purpose**: Browse/search all ingested docs across sources and folders.
- **Layout**: Fixed left sidebar (248px) + flexible main column. Main: header (title + subtitle) → pill filter row (horizontal, wrapping) → responsive grid of doc cards (`repeat(3, minmax(0,1fr))` desktop, `1fr` mobile <860px), 20px gap.
- **Doc card**: white bg, 1px border `oklch(88% 0.015 95)`, 14px radius, 20px padding, hover lifts `translateY(-2px)`. Contents top-to-bottom: source label (accent-colored, 11.5px/600), title (Source Serif 4, 17px/600), excerpt (12.5px, muted), folder + relative time (11.5px, muted). Whole card is clickable → opens Reader.
- **Filter pills**: full-pill radius 99px, active = filled ink `oklch(24% 0.02 75)` bg / white text, inactive = white bg / muted text, no border.

### 2. Import & Sources
- **Purpose**: Connect Claude, Cursor, GitHub, local Markdown, etc.; monitor recent imports.
- **Layout**: single column, max-width 840px. Header → connector list (vertical stack, not grid) → "Recent imports" list below.
- **Connector row**: white card, 1px border, 12px radius, 16-18px padding, flex row: 36px icon tile (initials, tinted bg per source) → name + one-line description (flex:1) → right-aligned action label (`Connected` muted green text / `Connect` or `Upload` in accent color, no button chrome — just colored text, click target).
- **Recent imports row**: no card wrapper — flat list, 1px bottom divider, title (truncates) + right-aligned relative time. Deliberately minimal (no source badge/status pill) to avoid clutter.
- Note: GitHub ships **not connected** by default (per product decision — team didn't want GitHub connected out of the box).

### 3. Document Reader
- **Purpose**: Read a single doc with source metadata, tags, related docs, and an agent-access CTA.
- **Layout**: flex row — content column (flex:1, centered, max-width 660px, 48-56px padding) + right rail (280px, left border, own padding). On mobile (<860px) this stacks to a column: content first, rail below as a footer section (no left border, top border instead).
- **Content column**: source/project label (accent-colored, 12.5px/600) → title (Source Serif 4, 34px desktop / 26px mobile, 600, 1.2 line-height) → metadata line (date · reviewer, 12.5px muted) with bottom divider → body (Source Serif 4, 17.5px desktop / 18.5px mobile for easier on-the-go reading, 1.75/1.85 line-height respectively), section headings at 20px/600, one monospace code block (14px, light bg, no border needed beyond bg contrast).
- **Right rail**: Tags (pill chips, no border, light bg) → Related docs (plain text list, no cards) → sticky-feeling bottom CTA "Ask agent about this" (filled accent, 10px radius, centered white text).

## Mobile Behavior (<860px breakpoint)
- Sidebar becomes a full-screen overlay (`position:fixed; inset:0; z-index:20`), hidden by default.
- A top bar (logo + hamburger ☰) appears in place of the persistent sidebar; tapping ☰ opens the overlay sidebar with a ✕ close button.
- Library grid collapses to 1 column.
- Reader stacks content above the metadata rail instead of side-by-side, and bumps body font size up (18.5px vs 17.5px) with slightly looser line-height — optimized for reading on a phone while walking, not scanning a dense two-pane layout.
- All breakpoint logic is driven by a `width` state value read from `window.innerWidth` + a resize listener (see component logic) — recreate as a standard responsive hook/media query in the target framework rather than JS-measured width if the codebase prefers CSS.

## Interactions & Behavior
- Sidebar nav items (Library / Import & Sources / Agent Access) switch the visible screen; active item gets white pill bg + ink text + accent-colored leading dot.
- Clicking any Library doc card navigates to the Reader screen (placeholder always loads the same sample doc — wire to real doc ID on click).
- Mobile hamburger toggles sidebar overlay open/closed; selecting a nav item closes it.
- No modals, no multi-step forms in this pass — "+ Add source" and connector "Connect" actions are visual endpoints only (wire to real OAuth/connect flows).

## Design Tokens

**Colors** (OKLCH):
- Background (page): `oklch(96.5% 0.014 95)`
- Sidebar/card-adjacent bg: `oklch(94.5% 0.016 95)`
- Card surface: `oklch(100% 0 0)` (white)
- Border (hairline): `oklch(88% 0.015 95)` – `oklch(91% 0.015 95)` range depending on contrast need
- Ink / primary text: `oklch(20% 0.02 75)` – `oklch(24% 0.02 75)`
- Muted text: `oklch(45–55% 0.02 75)`
- **Accent (signature/AI color)**: `oklch(55% 0.23 300)` — an electric violet, tweakable via the `accentColor` prop. Alternate curated options: warm red `oklch(58% 0.22 15)`, green `oklch(55% 0.2 165)`, neutral ink `oklch(50% 0.02 70)`.
- Source tint colors (per-connector accent, used sparingly for source labels/icon tiles): Claude ~`oklch(48% 0.14 40)` (warm), Cursor ~`oklch(45% 0.12 260)` (blue), Markdown/success ~`oklch(45% 0.1 145)` (green).

**Typography**:
- UI font: **Space Grotesk** (400/500/600/700) — nav, labels, buttons, metadata.
- Reading font: **Source Serif 4** (optical size 8–60, 400/500/600) — all document titles and long-form body text, used via a `.serif` / `h1,h2,h3` helper rule.
- Code: `ui-monospace, monospace` for the one code sample block.
- Scale: sidebar labels 13.5px, section headers 26–30px, card titles 16.5–17px, body copy 12.5–14px, reader body 17.5–18.5px.

**Spacing/radius**: 4/6/7/8/10/12/14px radii depending on component weight (chips=99px full pill, cards=12-14px, small icon tiles=7-9px). Grid/list gaps 8-26px depending on density.

## Assets
No custom icons or illustrations — all visual marks are CSS (colored dots, initials in colored tiles). No external images used; this is a text/data-dense workspace UI, not an imagery-led design.

## Files
- `Vault.dc.html` — full interactive prototype (Library / Import & Sources / Document Reader), including the responsive/mobile logic described above. This is the primary reference; read it top-to-bottom alongside this README.
