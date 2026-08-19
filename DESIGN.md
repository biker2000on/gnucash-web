# Design System - GnuCash Web

## Product Context
- **What this is:** A full-featured personal finance PWA for viewing and managing GnuCash financial data
- **Who it's for:** Personal use (single user, power user who cares about data density and precision)
- **Space/industry:** Personal finance, accounting tools (peers: Copilot, Monarch, YNAB, Lunch Money, GnuCash desktop)
- **Project type:** Web app / dashboard with data-dense financial views

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian
- **Decoration level:** Minimal (borders and subtle elevation only, no decorative elements)
- **Mood:** Precision financial tool with quiet confidence. Bloomberg terminal meets a well-designed fintech dashboard. Data-dense, function-first, professional.

## Typography
- **Display/Hero:** DM Sans (700) - clean geometric sans, reads authoritative at large sizes
- **Body:** DM Sans (400/500) - excellent at 13-14px for dense financial data, clean and legible
- **UI/Labels:** DM Sans (500/600) - same family for cohesion, weight creates hierarchy
- **Data/Tables:** JetBrains Mono (400/500/600) - every digit same width, columns align perfectly. Use with `font-feature-settings: 'tnum'`
- **Code:** JetBrains Mono (400)
- **Loading:** Google Fonts CDN
  ```html
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  ```
- **Scale:** 12 / 13 / 14 / 16 / 20 / 24 / 32px

## Color

### Approach
Restrained. One accent color + navy/slate neutrals. Color is rare and meaningful: green = positive, red = negative, teal = interactive.

### Dark Theme (Primary)
| Token | Hex | Usage |
|-------|-----|-------|
| `--background` | `#0c1322` | Page background (deep navy) |
| `--background-secondary` | `#101828` | Sidebar, secondary surfaces |
| `--background-tertiary` | `#131d2e` | Subtle depth layers |
| `--surface` | `#131d2e` | Cards, panels |
| `--surface-elevated` | `#1a2742` | Modals, dropdowns, popovers |
| `--surface-hover` | `#1e2d4a` | Hover states on surfaces |
| `--border` | `#243049` | Default borders |
| `--border-hover` | `#2d3d5a` | Hover/focus borders |
| `--foreground` | `#e2e8f0` | Primary text |
| `--foreground-secondary` | `#94a3b8` | Secondary text, labels |
| `--foreground-muted` | `#64748b` | Muted text, placeholders |
| `--primary` | `#2dd4bf` | Accent (teal-400), interactive elements |
| `--primary-hover` | `#5eead4` | Accent hover state |
| `--primary-light` | `rgba(45,212,191,0.12)` | Accent background tint |
| `--primary-foreground` | `#0c1322` | Text on accent background |
| `--secondary` | `#60a5fa` | Info, secondary accent (blue) |
| `--secondary-hover` | `#93c5fd` | Secondary accent hover |
| `--secondary-light` | `rgba(96,165,250,0.1)` | Secondary background tint |
| `--positive` | `#4ade80` | Positive amounts, gains |
| `--negative` | `#f87171` | Negative amounts, losses |
| `--warning` | `#fbbf24` | Warnings |
| `--success` | `#4ade80` | Success states |
| `--error` | `#f87171` | Error states |

### Light Theme
| Token | Hex | Usage |
|-------|-----|-------|
| `--background` | `#f8fafc` | Page background |
| `--background-secondary` | `#f1f5f9` | Sidebar, secondary surfaces |
| `--background-tertiary` | `#e2e8f0` | Depth layers |
| `--surface` | `#ffffff` | Cards, panels |
| `--surface-elevated` | `#ffffff` | Modals, dropdowns |
| `--surface-hover` | `#f1f5f9` | Hover states |
| `--border` | `#e2e8f0` | Default borders |
| `--border-hover` | `#cbd5e1` | Hover/focus borders |
| `--foreground` | `#0f172a` | Primary text |
| `--foreground-secondary` | `#475569` | Secondary text |
| `--foreground-muted` | `#94a3b8` | Muted text |
| `--primary` | `#0d9488` | Accent (teal-600, darker for white bg contrast) |
| `--primary-hover` | `#0f766e` | Accent hover |
| `--primary-light` | `rgba(13,148,136,0.08)` | Accent background tint |
| `--primary-foreground` | `#ffffff` | Text on accent background |
| `--positive` | `#16a34a` | Positive amounts |
| `--negative` | `#dc2626` | Negative amounts |

### Money vs. system state (`--negative` vs `--error`)
`--positive`/`--negative` and `--success`/`--error` resolve to the same hexes today. They are still four
distinct roles and must not be collapsed into two — either pair may be re-tuned independently later
(e.g. a colour-blind-safe money palette) without dragging the other with it.

| Role | Tokens | Use for | Never for |
|------|--------|---------|-----------|
| Money | `--positive` / `--negative` | The sign of an amount, balance, gain/loss, budget variance | Validation errors, failed requests, destructive buttons |
| System state | `--success` / `--error` | Validation failures, request failures, destructive confirmations, required markers, save confirmations | Amounts |

A −$40 balance is not an error. If a red thing on screen is not a number below zero, it is `--error`.
The canonical recipes live in `src/components/ui/form.tsx` (`INPUT_INVALID`, `FIELD_ERROR`); the
contract is restated next to the tokens in `src/app/globals.css`.

### Gradient Policy
**No gradients. Ever.** All buttons, headings, backgrounds, and icons use solid colors. The emerald-to-cyan gradient pattern is explicitly banned. If visual hierarchy is needed, use borders, elevation (shadow), or background tint instead.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable (not cramped, not airy)
- **Scale:** 2xs(4) xs(8) sm(12) md(16) lg(24) xl(32) 2xl(48) 3xl(64)

## Layout
- **Approach:** Grid-disciplined (data tables, sidebars, metric cards need clean alignment)
- **Grid:** 12 columns, collapsing to 4 on mobile
- **Max content width:** 1400px
- **Border radius:** sm: 4px, md: 6px, lg: 10px, full: 9999px (avatars only)
  - The scale is closed. `rounded-xl` (12px), `rounded-2xl` (16px) and `rounded-3xl` (24px) are **not**
    on it and are banned everywhere — including cards, panels and modals, which use `rounded-lg`.
  - Tailwind mapping: `rounded-sm` → sm, `rounded-md` → md, `rounded-lg` → lg, `rounded-full` → full.
  - Form controls (`input`/`select`/`textarea`) are radius **md**, via the shared `INPUT`/`SELECT`/
    `TEXTAREA` recipes in `src/components/ui/form.tsx`. Do not hand-roll a fourth input recipe: a form
    control's radius, padding, type size, border and focus ring all come from those constants
    (compose extras through `inputClass({ extra })`).

## Motion
- **Approach:** Minimal-functional (only transitions that aid comprehension)
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150ms) medium(200ms) long(300ms)
- **Rules:** No bouncy animations. No entrance animations on page load. Hover transitions at 150ms. Panel open/close at 200ms. This is a financial tool.

## Sidebar
- **Background:** `--background-secondary`
- **Border:** 1px solid `--border` on the right edge
- **Active item:** Left border accent (`--primary`), tinted background (`--primary-light`), text in `--primary`
- **Text:** `--foreground-secondary` default, `--foreground` on hover
- **Section labels:** 10px uppercase, `--foreground-muted`

## Financial Data Display
- **All monetary values:** JetBrains Mono with `font-feature-settings: 'tnum'`
- **Positive amounts:** `--positive` (#4ade80 dark / #16a34a light)
- **Negative amounts:** `--negative` (#f87171 dark / #dc2626 light)
- **Neutral amounts:** `--foreground-secondary`
- **Table column alignment:** Right-align all numeric columns
- **Date format in tables:** Use JetBrains Mono for dates too (consistent monospace column)

## Tooltips and hints
- **Native `title=` is banned on every DOM element.** It never appears on touch, cannot be opened or
  dismissed from the keyboard, cannot be styled, waits ~1s before appearing, and reaches screen readers
  only inconsistently and by opt-in. `src/__tests__/no-native-title.test.ts` parses every `.tsx` file and
  fails on any new one; its allowlist is empty and must stay that way.
- **Explanatory hint → `<Tip content="…">`** (`src/components/ui/Tooltip.tsx`). `Tip` renders no element
  of its own — it clones its single child and merges in the handlers, the ref and `aria-describedby` — so
  it wraps a `<td>`, a `<tr>` cell or a button inside a flex row without touching layout, DOM validity or
  tab order. Opens on hover, keyboard focus and tap; dismisses on Escape, blur and outside tap. On a
  **disabled** child (which fires no pointer events) it falls back to a permanently mounted hidden
  description, the only channel such a control has.
- **Icon-only control → `aria-label`**, plus `<Tip … describedBy={false}>` when sighted users also need
  the text. A control with no visible text and no `aria-label` has no accessible name at all; a tooltip
  does not give it one.
- **A hint that is really a form control's label → `aria-label`** on the control (or a real `<label>`),
  not a tooltip.
- `<abbr title>`, `<iframe title>` and SVG `<title>` are unaffected — there `title` is the platform's own
  naming mechanism, not a hover hint.
- Exception, still: an abbreviation uses `<Abbr>` (below), which is built on `Tooltip` and adds the
  glossary lookup and the dotted-underline affordance.

## Abbreviations
- **Every user-visible abbreviation must render through `<Abbr term="..." />`** (`src/components/ui/Abbr.tsx`), backed by the central glossary in `src/lib/glossary.ts` (term → expansion + optional one/two-sentence plain-English gloss). Add new terms to the glossary first.
- **Affordance:** the abbreviation gets a dotted underline and a small (i) icon; the tooltip (shared `src/components/ui/Tooltip.tsx` primitive) opens on hover, keyboard focus, and tap, and dismisses on Escape/blur/outside tap. Native `title=` attributes are banned for this purpose (no mobile support, no styling, no discoverability).
- **Coverage rule:** the FIRST occurrence of an abbreviation in a view gets the `<Abbr>`; repeated occurrences in a table column get the hint in the column header instead — never per cell. Repeats in running prose after the first occurrence stay plain.
- **Inside interactive elements** (a clickable card `<button>`, a `<Link>`): pass `nested` — the trigger renders without `role`/`tabIndex` (HTML forbids focusable descendants there) and opens on hover/tap only. A tap on any Abbr trigger reads the hint and never activates the ancestor (label toggle, navigation). `<option>` text cannot carry markup — put the hint on adjacent helper text or the control's label instead.
- **Tooltip styling:** `--surface-elevated` panel, 1px `--border`, radius md (6px), 13px body, expansion in `--foreground` (500), gloss in `--foreground-secondary`. Works in both themes via semantic tokens only.
- A lint-style test (`src/__tests__/abbr-coverage.test.ts`) sweeps `src/components/` and `src/app/(main)/` for known glossary terms rendered as bare JSX text; new surfaces must use `<Abbr>` or the test fails. Do not grow its allowlist for new code.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-03 | Initial design system created | Created by /design-consultation. Dark navy + teal accent + DM Sans/JetBrains Mono |
| 2026-04-03 | Teal over emerald | Teal reads more sophisticated on navy; same green family but more refined |
| 2026-04-03 | No gradients policy | Emerald-to-cyan gradients across ~20 instances feel cheesy; solid colors are more professional |
| 2026-04-03 | Dark navy over pure black | Navy (#0c1322) is warmer, easier on eyes for long sessions, and makes teal accent pop |
| 2026-04-03 | JetBrains Mono for all financial data | Tabular-nums ensures perfect column alignment for account balances and transaction amounts |
| 2026-08-04 | Abbreviation glossary + `<Abbr>` tooltips | App is dense with tax/finance abbreviations; central glossary with (i) hover/focus/tap tooltips beats scattered `title=` attributes |
| 2026-08-19 | Radius scale closed; `rounded-xl`/`2xl` removed everywhere | 446 uses sat off the published scale, including on cards and modals; the doc has no carve-out for them |
| 2026-08-19 | One input recipe (`INPUT`/`SELECT`/`TEXTAREA` in `ui/form.tsx`) | Three forms had three different recipes; a shared constant is the only thing that keeps radius, padding and focus consistent |
| 2026-08-19 | `--negative` is money-only; `--error` is system state | Same hex today, different roles; writing the split down is what lets either pair be re-tuned later |
| 2026-08-19 | Native `title=` banned app-wide, replaced by `Tip` | The 2026-08-04 rule only covered abbreviations; ~350 other sites kept an untouchable, unstyleable, touch-invisible hint |
