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

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-03 | Initial design system created | Created by /design-consultation. Dark navy + teal accent + DM Sans/JetBrains Mono |
| 2026-04-03 | Teal over emerald | Teal reads more sophisticated on navy; same green family but more refined |
| 2026-04-03 | No gradients policy | Emerald-to-cyan gradients across ~20 instances feel cheesy; solid colors are more professional |
| 2026-04-03 | Dark navy over pure black | Navy (#0c1322) is warmer, easier on eyes for long sessions, and makes teal accent pop |
| 2026-04-03 | JetBrains Mono for all financial data | Tabular-nums ensures perfect column alignment for account balances and transaction amounts |
