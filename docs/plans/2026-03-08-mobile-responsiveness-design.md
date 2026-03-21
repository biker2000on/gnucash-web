# Mobile Responsiveness & PWA Overhaul

## Section 1: PWA Setup

The app already has `next-pwa` configured with service worker, manifest, and `standalone` display mode. Missing pieces:

- **Viewport metadata**: Add to `src/app/layout.tsx` via Next.js `viewport` export (`width: device-width, initial-scale: 1, viewport-fit: cover`)
- **Manifest link**: Add manifest reference via Next.js `metadata` export
- **Icons**: Generate 192x192 and 512x512 PNGs from the existing SVG icon, add to manifest
- **Apple-specific**: Add `apple-touch-icon` and `apple-mobile-web-app-capable` meta tags for iOS

## Section 2: Table-to-Card Transformation

**Breakpoint**: Below `md` (768px) tables switch to card view.

**Approach**: Create a reusable `<ResponsiveTable>` wrapper component that renders a standard `<table>` on `md+` and a stacked card layout on mobile. Each table component provides a card renderer.

**Pattern for each table**:
- Desktop (`md+`): Existing table renders unchanged
- Mobile (`<md`): Each row becomes a card with all fields stacked as label/value pairs, separated by borders/spacing
- Edit mode in AccountLedger: Hidden on mobile with message directing to form-based entry

**Tables to convert** (7 components):
1. `TransactionJournal.tsx` — general ledger
2. `AccountLedger.tsx` — per-account ledger (readonly card view only)
3. `reports/LedgerTable.tsx` — general ledger report
4. `reports/JournalTable.tsx` — general journal report
5. `reports/PortfolioTable.tsx` — investment portfolio report
6. `reports/TrialBalanceTable.tsx` — trial balance report
7. `investments/HoldingsTable.tsx` — consolidated holdings

**Card layout** (example for transaction):
```
┌─────────────────────────┐
│ Jan 15, 2026            │
│ Grocery Store           │
│ Expenses:Food    $45.00 │
│ Balance:       $1,234   │
└─────────────────────────┘
```

Cards tappable to open transaction view/edit modal.

## Section 3: Forms & Modals on Mobile

**Modals**: Modify `src/components/ui/Modal.tsx` to automatically use `fullscreen` size when viewport is below `md` (768px). Applies to all modals app-wide.

**Forms**:
- `TransactionForm.tsx` — Split rows stack vertically, account selector and amount fields full-width. Advanced mode multi-split layout: each split as its own block.
- `LoginForm.tsx` — Already `max-w-md`, verify padding.
- `AccountForm.tsx`, `BudgetForm.tsx`, `DepreciationScheduleForm.tsx` — Verify `grid-cols-1` on mobile.
- `FilterPanel.tsx` — Filters stack vertically on mobile.

**Touch targets**: Audit buttons, checkboxes, and interactive elements for minimum 44px tap target on mobile. Key areas: table action buttons, reconciliation checkboxes, period selectors, nav items.

## Section 4: Layout, Navigation & Toolbar Audit

**Sidebar**: Already has mobile slide-in drawer with hamburger menu — verify touch target sizes.

**Toolbar/filter bars**: On mobile (`<md`), toolbar controls stack — one control per line or grouped logically (2 small buttons per line max).

Toolbars to audit and fix:

| Page/Component | Controls |
|---|---|
| `AccountLedger.tsx` | Search, date range, unreviewed toggle, edit mode toggle, reconcile, bulk actions |
| `TransactionJournal.tsx` | Search input, filter panel toggle, column filters |
| `FilterPanel.tsx` | Account type, date range, amount range, reconcile state |
| `/accounts/page.tsx` | Sort dropdown, filter input, visibility toggles |
| `/budgets/[guid]/page.tsx` | Period selector, show-all-accounts toggle |
| `/investments/page.tsx` | Tab buttons, fetch prices, settings |
| Report pages | Date range picker, period selector, export/print buttons |
| Dashboard | Period selector, chart settings |

**Approach**: Each toolbar becomes `flex flex-col md:flex-row` with full-width controls on mobile. Search inputs full-width. Small toggle buttons pair up in `grid grid-cols-2`.

**Account hierarchy**: Reduce tree indentation on mobile to prevent content overflow.

**Edit mode on mobile**: Hide "Edit Mode" toggle button on mobile. Show message if somehow entered: "Edit mode is not available on mobile. Use the + button to add transactions."

**Dashboard**: KPI grid already responsive. Charts use ResponsiveContainer. Minimal tweaks expected.
