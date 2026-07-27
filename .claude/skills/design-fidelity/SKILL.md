---
name: design-fidelity
description: How to read the Strata design handoff and translate it into code without drift. Read before building or reviewing any UI in apps/web. Covers the prototype's DSL, the exact token set, the values the README rounds off, and the traps that produce near-miss implementations.
---

# Design fidelity

## What the handoff is

`design/handoff/Vault.dc.html` is a **design-tool prototype**, not source. It uses a templating
DSL — `<sc-if value="{{ x }}">`, `<sc-for list="{{ y }}" as="d">`, `{{ interpolation }}` — with a
`class Component extends DCLogic` block at the bottom holding the real state logic and data.

Read it for: exact values, responsive logic, data shapes, interaction behavior.
Never port: its markup, its inline styles, its `sc-*` elements, its placeholder strings.

`design/handoff/README.md` is the prose spec. **Where the two disagree, the HTML wins** — and the
disagreement is worth reporting.

## Token set

Transcribed from the handoff into `packages/tokens`. Do not use a value that is not here; add it
there first with a citation.

**Surfaces**

| Token | Value | Used for |
| --- | --- | --- |
| `bg-page` | `oklch(96.5% 0.014 95)` | Page background |
| `bg-sunken` | `oklch(94.5% 0.016 95)` | Sidebar, mobile top bar |
| `bg-surface` | `oklch(100% 0 0)` | Cards, search field, active nav pill |
| `bg-chip` | `oklch(95% 0.015 95)` | Tag pills |
| `bg-code` | `oklch(95.5% 0.015 95)` | Reader code block |

**Borders** — three distinct values. They are not interchangeable.

| Token | Value | Used for |
| --- | --- | --- |
| `border-structural` | `oklch(88% 0.015 95)` | Sidebar edge, reader rail, top bar |
| `border-card` | `oklch(89% 0.015 95)` | Doc cards, connector rows, reader metadata rule |
| `border-hairline` | `oklch(91% 0.015 95)` | Recent-imports dividers |
| `border-control` | `oklch(87% 0.015 95)` | Search field, hamburger, close button |

**Text**

| Token | Value |
| --- | --- |
| `ink` | `oklch(20% 0.02 75)` (body default) |
| `ink-title` | `oklch(22% 0.02 75)` card titles · `oklch(24% 0.02 75)` reader body, active nav |
| `ink-muted` | `oklch(48% 0.02 75)` |
| `ink-subtle` | `oklch(52–55% 0.02 75)` |
| `ink-inverse` | `oklch(99% 0.005 90)` — text on accent/ink fills, **not pure white** |

**Accent** — `oklch(55% 0.23 300)` electric violet. It is a **prop with a default**, not a
constant. Hardcoding it is drift. Curated alternates: `oklch(58% 0.22 15)`,
`oklch(55% 0.2 165)`, `oklch(50% 0.02 70)`.

**Source tints** — per connector, used sparingly:
Claude `oklch(48% 0.14 40)` on `oklch(93% 0.05 40)` · Cursor `oklch(45% 0.12 260)` on
`oklch(90% 0.04 260)` · Markdown `oklch(45% 0.1 145)` on `oklch(92% 0.05 145)` · GitHub
`oklch(30% 0.01 70)` on `oklch(90% 0.008 90)`.

**Type** — Space Grotesk (400/500/600/700) for UI; Source Serif 4 (opsz 8–60, 400/500/600) for
document titles and long-form body; `ui-monospace` for the one code block. Sizes are deliberately
non-round: 11.5 / 12 / 12.5 / 13 / 13.5 / 14 / 17 / 20 / 26 / 28 / 34 px. Never round them.

## Responsive

One breakpoint: **860px**. The prototype computes it from a JS `width` state with a resize
listener; in the app it is a CSS media query. Do not reimplement JS measurement.

| Property | Desktop | Mobile |
| --- | --- | --- |
| Sidebar | 248px fixed, in flow | `position:fixed; inset:0; z-index:20`, toggled |
| Main padding | `40px 48px` | `20px 18px` |
| Library grid | `repeat(3, minmax(0,1fr))` | `1fr` |
| Reader direction | `row` | `column` |
| Reader title | 34px | 26px |
| Reader body | 17.5px / 1.75 | **18.5px / 1.85** |
| Reader rail | 280px, `border-left`, `32px 24px` | 100%, `border-top`, `20px 18px` |

The reader body **grows** on mobile while everything else shrinks — deliberate, for reading on a
phone. Getting this backwards is the most common single error.

## Traps

1. **Near-miss borders.** `88%` vs `89%` vs `91%` are three different tokens doing three
   different jobs. Auditors should check these first; they are invisible and always wrong.
2. **`oklch(99% 0.005 90)` is not white.** Inverse text is warm off-white throughout.
3. **Accent is a prop.** Thread it; do not inline it.
4. **Placeholder copy.** "312 docs", "Priya Shah", "4 agents connected", every doc title — all
   placeholder. Wire to real data via `packages/core` types and a single fixtures module.
5. **The nav lies.** In the prototype the third nav item is labelled "Agent Access" but routes to
   the reader screen. That is prototype scaffolding, not a spec. Agent Access is a real screen
   that does not exist yet — do not implement the alias.
6. **Card hover is `translateY(-2px)` with `transition: transform .15s`.** No shadow change.
7. **No icons, no images.** Every mark is CSS — colored dots, initials in tinted tiles. Do not
   introduce an icon library.

## Loop

Build → `npm run verify` → delegate to `strata-fidelity-auditor`. The hook blocks raw `oklch()`
in `apps/web`, which catches the largest class of drift for free.
