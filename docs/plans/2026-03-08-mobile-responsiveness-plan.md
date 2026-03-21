# Mobile Responsiveness & PWA Overhaul — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the app fully mobile-responsive with installable PWA support, card-based table views on mobile, fullscreen modals, and stacked toolbars.

**Architecture:** 4 phases executed incrementally: (1) PWA metadata & icons, (2) reusable ResponsiveTable + convert 7 tables, (3) modal auto-fullscreen + form fixes, (4) toolbar stacking + edit mode hiding. Each phase is independently deployable.

**Tech Stack:** Next.js 16, React 19, Tailwind CSS 4, next-pwa, sharp (icon generation)

---

## Phase 1: PWA Setup

### Task 1.1: Add viewport and manifest metadata to root layout

**Files:**
- Modify: `src/app/layout.tsx`

**Step 1: Add viewport export and update metadata**

In `src/app/layout.tsx`, add a `viewport` export and update `metadata` to include manifest link and Apple meta:

Add after imports:
```typescript
import type { Metadata, Viewport } from "next";
```

Replace the existing `metadata` export with:
```typescript
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#10b981',
};

export const metadata: Metadata = {
  title: "GnuCash Web PWA",
  description: "Modern web interface for GnuCash",
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'GnuCash Web',
  },
};
```

**Step 2: Verify**

Run: `npm run build` — should compile without errors.

**Step 3: Commit**

```bash
git add src/app/layout.tsx
git commit -m "feat: add viewport metadata and PWA manifest link to root layout"
```

---

### Task 1.2: Generate PNG icons and update manifest

**Files:**
- Create: `public/icons/icon-192x192.png`
- Create: `public/icons/icon-512x512.png`
- Modify: `public/manifest.json`

**Step 1: Generate PNG icons from SVG**

Use sharp to convert the SVG icon to PNG at required sizes. Run this one-time script:

```bash
npx sharp-cli -i public/icons/icon.svg -o public/icons/icon-192x192.png resize 192 192
npx sharp-cli -i public/icons/icon.svg -o public/icons/icon-512x512.png resize 512 512
```

If `sharp-cli` is not available, use a Node script:
```bash
node -e "
const sharp = require('sharp');
async function gen() {
  await sharp('public/icons/icon.svg').resize(192, 192).png().toFile('public/icons/icon-192x192.png');
  await sharp('public/icons/icon.svg').resize(512, 512).png().toFile('public/icons/icon-512x512.png');
  console.log('Icons generated');
}
gen();
"
```

If sharp is not installed, install it first: `npm install sharp --save-dev` (it's likely already a dependency of Next.js).

**Step 2: Update manifest.json**

Replace `public/manifest.json`:
```json
{
    "name": "GnuCash Web",
    "short_name": "GnuCash",
    "description": "Modern web interface for GnuCash",
    "start_url": "/",
    "display": "standalone",
    "background_color": "#0a0a0a",
    "theme_color": "#10b981",
    "icons": [
        {
            "src": "/icons/icon.svg",
            "sizes": "any",
            "type": "image/svg+xml",
            "purpose": "any"
        },
        {
            "src": "/icons/icon-192x192.png",
            "sizes": "192x192",
            "type": "image/png",
            "purpose": "any maskable"
        },
        {
            "src": "/icons/icon-512x512.png",
            "sizes": "512x512",
            "type": "image/png",
            "purpose": "any maskable"
        }
    ]
}
```

**Step 3: Add apple-touch-icon link**

In `src/app/layout.tsx`, add inside the `<head>` tag (after `<ThemeScript />`):
```tsx
<link rel="apple-touch-icon" href="/icons/icon-192x192.png" />
```

**Step 4: Verify**

Run: `npm run build` — should compile without errors.

**Step 5: Commit**

```bash
git add public/icons/icon-192x192.png public/icons/icon-512x512.png public/manifest.json src/app/layout.tsx
git commit -m "feat: generate PWA icons and update manifest with PNG sizes"
```

---

## Phase 2: Table-to-Card Transformation

### Task 2.1: Create useIsMobile hook

**Files:**
- Create: `src/lib/hooks/useIsMobile.ts`

**Step 1: Create the hook**

```typescript
'use client';

import { useState, useEffect } from 'react';

const MOBILE_BREAKPOINT = 768; // matches Tailwind md:

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    setIsMobile(mql.matches);

    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}
```

**Step 2: Verify**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/lib/hooks/useIsMobile.ts
git commit -m "feat: add useIsMobile hook for responsive breakpoint detection"
```

---

### Task 2.2: Create MobileCard component

**Files:**
- Create: `src/components/ui/MobileCard.tsx`

**Step 1: Create the reusable card component**

This renders a single row's data as a stacked card with label/value pairs.

```typescript
'use client';

import { ReactNode } from 'react';

export interface CardField {
  label: string;
  value: ReactNode;
  className?: string;
}

interface MobileCardProps {
  fields: CardField[];
  onClick?: () => void;
  className?: string;
  children?: ReactNode;
}

export function MobileCard({ fields, onClick, className = '', children }: MobileCardProps) {
  return (
    <div
      onClick={onClick}
      className={`p-4 border-b border-border ${onClick ? 'cursor-pointer active:bg-surface-hover' : ''} ${className}`}
    >
      {fields.map((field, i) => (
        <div key={i} className={`flex justify-between items-baseline py-0.5 ${field.className || ''}`}>
          <span className="text-xs text-foreground-muted uppercase tracking-wider">{field.label}</span>
          <span className="text-sm text-foreground text-right">{field.value}</span>
        </div>
      ))}
      {children}
    </div>
  );
}
```

**Step 2: Verify**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/components/ui/MobileCard.tsx
git commit -m "feat: add reusable MobileCard component for table-to-card transformation"
```

---

### Task 2.3: Convert TransactionJournal to card view on mobile

**Files:**
- Modify: `src/components/TransactionJournal.tsx`

**Step 1: Add mobile card view**

Import `useIsMobile` and `MobileCard` at the top of the file. Then in the render, wrap the existing `overflow-x-auto` table div with a conditional:

- If `isMobile`: Render a list of `MobileCard` components for each transaction, with fields: Date, Description, Account (first split's account name), Debit, Credit. Each card `onClick` opens the view modal (same as clicking a row).
- If `!isMobile`: Render the existing table as-is.

The key pattern:
```tsx
const isMobile = useIsMobile();

// In the return, replace the overflow-x-auto div:
{isMobile ? (
  <div>
    {displayTransactions.map(tx => (
      <MobileCard
        key={tx.guid}
        onClick={() => { setSelectedTxGuid(tx.guid); setIsModalOpen(true); }}
        fields={[
          { label: 'Date', value: tx.post_date?.split(' ')[0] || '' },
          { label: 'Description', value: tx.description },
          { label: 'Account', value: /* first split account name */ },
          { label: 'Debit', value: /* debit amount */ },
          { label: 'Credit', value: /* credit amount */ },
        ]}
      />
    ))}
  </div>
) : (
  // existing table JSX unchanged
)}
```

Read the existing table rendering code carefully to extract the exact values for each field (debit/credit calculation, account name extraction from splits). Mirror the same logic used for the table cells.

**Step 2: Verify**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/components/TransactionJournal.tsx
git commit -m "feat: add mobile card view for TransactionJournal"
```

---

### Task 2.4: Convert AccountLedger to card view on mobile

**Files:**
- Modify: `src/components/AccountLedger.tsx`

**Step 1: Add mobile card view**

Import `useIsMobile` and `MobileCard`. In the render:

- If `isMobile` and `isEditMode`: Show a message "Edit mode is not available on mobile. Use the + button to add transactions." with a button to exit edit mode.
- If `isMobile` and `!isEditMode`: Render cards for each transaction with fields: Date, Description, Transfer Account, Debit, Credit, Balance, Reconcile State. Each card `onClick` opens the view modal.
- If `!isMobile`: Existing table rendering unchanged.

Hide the "Edit Mode" toggle button on mobile: add `hidden md:inline-flex` to the edit mode button's className.

**Step 2: Verify**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: add mobile card view for AccountLedger, hide edit mode on mobile"
```

---

### Task 2.5: Convert report tables to card views on mobile

**Files:**
- Modify: `src/components/reports/LedgerTable.tsx`
- Modify: `src/components/reports/JournalTable.tsx`
- Modify: `src/components/reports/PortfolioTable.tsx`
- Modify: `src/components/reports/TrialBalanceTable.tsx`

**Step 1: Convert each report table**

For each file, import `useIsMobile` and `MobileCard`. Add the same conditional pattern: cards on mobile, table on desktop.

**LedgerTable** card fields: Date, Description, Debit, Credit, Balance
**JournalTable** card fields: Date, Description, Num, Account, Debit, Credit, Memo
**PortfolioTable** card fields: Account, Symbol, Shares, Price, Market Value, Cost Basis, Gain/Loss, Gain %
**TrialBalanceTable** card fields: Account, Account Type, Debit, Credit

Read each file first to understand the exact data structure and cell rendering logic before implementing.

**Step 2: Verify**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/components/reports/LedgerTable.tsx src/components/reports/JournalTable.tsx src/components/reports/PortfolioTable.tsx src/components/reports/TrialBalanceTable.tsx
git commit -m "feat: add mobile card views for report tables"
```

---

### Task 2.6: Convert HoldingsTable to card view on mobile

**Files:**
- Modify: `src/components/investments/HoldingsTable.tsx`

**Step 1: Add mobile card view**

Import `useIsMobile` and `MobileCard`. The holdings table has expandable commodity sections — on mobile, render each holding as a card with fields: Symbol, Full Name, Shares, Price, Market Value, Cost Basis, Gain/Loss, Gain %.

Read the file first to understand the expandable section structure and adapt accordingly.

**Step 2: Verify**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/components/investments/HoldingsTable.tsx
git commit -m "feat: add mobile card view for HoldingsTable"
```

---

## Phase 3: Forms & Modals on Mobile

### Task 3.1: Auto-fullscreen modals on mobile

**Files:**
- Modify: `src/components/ui/Modal.tsx`

**Step 1: Add mobile detection and auto-fullscreen**

Import `useIsMobile`. In the component, determine effective size:

```typescript
const isMobile = useIsMobile();
const effectiveSize = isMobile ? 'fullscreen' : size;
```

Update the `sizeClasses` for fullscreen to be truly full on mobile:
```typescript
const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    '2xl': 'max-w-5xl',
    fullscreen: 'max-w-[95vw] w-[95vw] h-[90vh]',
};
```

On mobile fullscreen, remove `rounded-2xl` and padding from the modal wrapper, and use `w-full h-full max-w-none max-h-none` for truly fullscreen:

```typescript
const mobileFullscreen = isMobile && effectiveSize === 'fullscreen';
```

Update the modal container:
- If `mobileFullscreen`: `className="fixed inset-0 z-[9999] flex items-stretch"` (no padding)
- Modal div: `w-full h-full rounded-none` instead of `rounded-2xl`

Use `effectiveSize` instead of `size` everywhere else.

**Step 2: Verify**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/components/ui/Modal.tsx
git commit -m "feat: auto-fullscreen modals on mobile viewports"
```

---

### Task 3.2: Fix TransactionForm layout for mobile

**Files:**
- Modify: `src/components/TransactionForm.tsx`
- Modify: `src/components/SplitRow.tsx`

**Step 1: Fix TransactionForm**

Read the full file first. Ensure:
- The date/description row stacks vertically on mobile: `flex flex-col md:flex-row`
- Account selectors go full-width on mobile
- Amount fields go full-width on mobile
- The simple mode "From Account" / "To Account" layout stacks

**Step 2: Fix SplitRow**

Read `src/components/SplitRow.tsx`. Ensure:
- Each split row's account + debit + credit fields stack vertically on mobile: `flex flex-col md:flex-row`
- Inputs use `w-full` on mobile

**Step 3: Verify**

Run: `npm run build`

**Step 4: Commit**

```bash
git add src/components/TransactionForm.tsx src/components/SplitRow.tsx
git commit -m "feat: make TransactionForm and SplitRow mobile-responsive"
```

---

### Task 3.3: Fix other forms for mobile

**Files:**
- Modify: `src/components/AccountForm.tsx`
- Modify: `src/components/filters/FilterPanel.tsx`

**Step 1: Fix AccountForm**

Read the file. Ensure grid layouts use `grid-cols-1` on mobile, `sm:grid-cols-2` on larger screens. Fields should be full-width on mobile.

**Step 2: Fix FilterPanel**

Read the file. Ensure filter controls stack vertically on mobile. The filter bar should use `flex flex-col md:flex-row`. Individual filter components (AccountTypeFilter, AmountFilter, ReconcileFilter) should be full-width on mobile.

**Step 3: Verify**

Run: `npm run build`

**Step 4: Commit**

```bash
git add src/components/AccountForm.tsx src/components/filters/FilterPanel.tsx
git commit -m "feat: make AccountForm and FilterPanel mobile-responsive"
```

---

### Task 3.4: Touch target audit

**Files:**
- Modify: Various components as needed

**Step 1: Audit and fix touch targets**

Search for buttons and interactive elements smaller than 44px. Common patterns to fix:
- Icon-only buttons (edit, delete): Add `min-w-[44px] min-h-[44px]` or increase padding
- Small toggle buttons: Ensure `py-2 px-3` minimum on mobile
- Checkbox labels: Ensure tappable area covers the label text

Key files to check:
- `src/components/AccountLedger.tsx` — action buttons, reconcile icons
- `src/components/TransactionJournal.tsx` — row action buttons
- `src/components/Layout.tsx` — nav items in mobile sidebar
- `src/components/investments/PerformanceChart.tsx` — period selector buttons

Use `md:` prefix to only apply larger sizes on mobile where desktop should stay compact.

Pattern: `p-1 md:p-1 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0` or similar approach using Tailwind responsive classes.

**Step 2: Verify**

Run: `npm run build`

**Step 3: Commit**

```bash
git add -A
git commit -m "fix: ensure minimum 44px touch targets on mobile"
```

---

## Phase 4: Layout & Toolbars

### Task 4.1: Stack AccountLedger toolbar on mobile

**Files:**
- Modify: `src/components/AccountLedger.tsx`

**Step 1: Fix toolbar layout**

The toolbar at lines 688-720 uses `flex justify-between items-center`. On mobile, this overflows.

Change the toolbar container to stack:
```tsx
<div className="p-4 border-b border-border flex flex-col md:flex-row md:justify-between md:items-center gap-3">
```

Group the buttons logically:
- Row 1 (mobile): "New Transaction" button (full-width on mobile)
- Row 2 (mobile): Toggles — unreviewed filter + edit mode (grid-cols-2)
- Row 3 (mobile): Reconciliation controls (if visible)

On desktop (`md+`): Same layout as before.

Also hide the reconciliation panel inline controls on mobile if they overflow — or stack them.

**Step 2: Verify**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: stack AccountLedger toolbar controls on mobile"
```

---

### Task 4.2: Stack TransactionJournal toolbar on mobile

**Files:**
- Modify: `src/components/TransactionJournal.tsx`

**Step 1: Fix toolbar layout**

The toolbar area has search input, filter toggle, and title. Read the toolbar section and ensure:
- Title and count on their own row
- Search input full-width on mobile
- Filter toggle buttons in a row below

The existing `flex flex-col md:flex-row` at line 353 is a good start — verify all children don't overflow.

**Step 2: Verify**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/components/TransactionJournal.tsx
git commit -m "feat: stack TransactionJournal toolbar controls on mobile"
```

---

### Task 4.3: Fix account hierarchy indentation on mobile

**Files:**
- Modify: `src/components/AccountHierarchy.tsx`

**Step 1: Reduce indentation on mobile**

Read the file and find where indentation is applied (likely a `paddingLeft` or `ml-` based on depth level). On mobile, reduce the indent multiplier:

Pattern:
```tsx
// Desktop: 24px per level, Mobile: 12px per level
style={{ paddingLeft: `${depth * (isMobile ? 12 : 24)}px` }}
```

Or use Tailwind responsive if class-based.

**Step 2: Verify**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/components/AccountHierarchy.tsx
git commit -m "feat: reduce account hierarchy indentation on mobile"
```

---

### Task 4.4: Fix remaining page toolbars

**Files:**
- Check and fix toolbars in: `src/app/(main)/accounts/page.tsx`, `src/app/(main)/budgets/[guid]/page.tsx`, `src/app/(main)/investments/page.tsx`, report pages, dashboard

**Step 1: Audit each page**

Read each file and check for toolbar/control bars that use `flex` with `gap` and might overflow on mobile. Apply the `flex flex-col md:flex-row` pattern as needed. Search inputs should be `w-full md:w-64` or similar.

**Step 2: Verify**

Run: `npm run build`

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: stack remaining page toolbar controls on mobile"
```

---

### Task 4.5: Final verification

**Step 1: Full build**

Run: `npm run build` — must pass with zero errors.

**Step 2: Lint**

Run: `npm run lint` — check for errors in changed files.

**Step 3: Verify all phases work**

Mentally verify:
- Phase 1: PWA installable with proper icons
- Phase 2: All 7 tables show cards on mobile, tables on desktop
- Phase 3: Modals fullscreen on mobile, forms don't overflow
- Phase 4: No toolbar overflow on any page
