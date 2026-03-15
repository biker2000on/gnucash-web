# Transaction View Modes — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement three transaction view modes for the account ledger (Basic Ledger, Transaction Journal, Auto-Split) with a View menu dropdown, keyboard chord shortcuts, and expand/collapse split rows.

**Architecture:** Generalize the chord system in KeyboardShortcutContext to support multiple prefixes. Add `ledgerViewStyle` user preference. Create a ViewMenu dropdown component. Extract split row rendering into shared components. Modify AccountLedger to render differently based on view mode.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, TanStack Table

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/contexts/KeyboardShortcutContext.tsx` | Generalize chord prefix system |
| Modify | `src/contexts/UserPreferencesContext.tsx` | Add `ledgerViewStyle` preference |
| Create | `src/components/ViewMenu.tsx` | View dropdown with mode + toggles |
| Create | `src/components/ledger/SplitRows.tsx` | Render split detail rows |
| Create | `src/components/ledger/BalancingRow.tsx` | Edit mode blank balancing row |
| Modify | `src/components/AccountLedger.tsx` | View mode state, conditional rendering, expand/collapse |
| Modify | `src/components/ledger/columns.tsx` | Add expand arrow column for basic mode |

---

### Task 1: Generalize Keyboard Chord System

**Files:**
- Modify: `src/contexts/KeyboardShortcutContext.tsx:177-196`

- [ ] **Step 1: Replace hardcoded 'g' prefix with dynamic prefix detection**

In `KeyboardShortcutContext.tsx`, find the chord initiation block (~lines 177-196). Currently it checks `event.key === 'g'`. Replace with logic that detects any registered chord prefix.

Replace the hardcoded check with:
```typescript
// Detect chord prefixes dynamically from registered shortcuts
const chordPrefixes = new Set<string>();
shortcuts.forEach((s) => {
  if (s.scope === 'global' && s.enabled && s.key.includes(' ')) {
    chordPrefixes.add(s.key.split(' ')[0]);
  }
});

if (chordPrefixes.has(event.key) && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
  event.preventDefault();
  chordPrefixRef.current = event.key;
  chordTimerRef.current = window.setTimeout(() => {
    chordPrefixRef.current = null;
  }, 500);
  return;
}
```

Note: The chord completion block (~lines 145-175) already uses `chordPrefixRef.current` generically — it does NOT hardcode `'g '`. Only the prefix detection block at lines 178-196 needs changing. Do NOT modify lines 145-175.

- [ ] **Step 2: Verify existing `g` chords still work**

Run: `npm run dev`
Test: `g d` (dashboard), `g a` (accounts), `g b` (book switcher) should all still work.

- [ ] **Step 3: Commit**

```bash
git add src/contexts/KeyboardShortcutContext.tsx
git commit -m "refactor: generalize keyboard chord system to support arbitrary prefixes"
```

---

### Task 2: Add ledgerViewStyle User Preference

**Files:**
- Modify: `src/contexts/UserPreferencesContext.tsx`

- [ ] **Step 1: Add the type and state**

Add the type definition near the existing `DefaultLedgerMode` type:
```typescript
export type LedgerViewStyle = 'basic' | 'journal' | 'autosplit';
```

Add to the context type interface:
```typescript
ledgerViewStyle: LedgerViewStyle;
setLedgerViewStyle: (style: LedgerViewStyle) => Promise<void>;
```

Add state variable alongside existing ones:
```typescript
const [ledgerViewStyle, setLedgerViewStyleState] = useState<LedgerViewStyle>('basic');
```

- [ ] **Step 2: Add load and save logic**

Follow the exact same pattern as existing preferences (e.g., `setBalanceReversal`):

Load: in the load effect, read `ledgerViewStyle` from the stored preferences and call `setLedgerViewStyleState`.

Save:
```typescript
const setLedgerViewStyle = async (style: LedgerViewStyle) => {
  setLedgerViewStyleState(style);
  // Update localStorage cache
  const cached = localStorage.getItem('gnucash-web-preferences');
  if (cached) {
    const prefs = JSON.parse(cached);
    prefs.ledgerViewStyle = style;
    localStorage.setItem('gnucash-web-preferences', JSON.stringify(prefs));
  }
  // Save to API
  await fetch('/api/user/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ledgerViewStyle: style }),
  });
};
```

Add to the context provider value.

- [ ] **Step 3: Commit**

```bash
git add src/contexts/UserPreferencesContext.tsx
git commit -m "feat: add ledgerViewStyle user preference (basic/journal/autosplit)"
```

---

### Task 3: Create ViewMenu Component

**Files:**
- Create: `src/components/ViewMenu.tsx`

- [ ] **Step 1: Create the dropdown component**

```tsx
'use client';

import { useState, useRef, useEffect } from 'react';
import { useUserPreferences, type LedgerViewStyle } from '@/contexts/UserPreferencesContext';

interface ViewMenuProps {
  showSubaccounts: boolean;
  onToggleSubaccounts: () => void;
  showUnreviewedOnly: boolean;
  onToggleUnreviewed: () => void;
  hasSubaccounts: boolean;
}

const VIEW_MODES: { value: LedgerViewStyle; label: string; shortcut: string }[] = [
  { value: 'basic', label: 'Basic Ledger', shortcut: 'v b' },
  { value: 'journal', label: 'Transaction Journal', shortcut: 'v j' },
  { value: 'autosplit', label: 'Auto-Split', shortcut: 'v a' },
];

export default function ViewMenu({
  showSubaccounts,
  onToggleSubaccounts,
  showUnreviewedOnly,
  onToggleUnreviewed,
  hasSubaccounts,
}: ViewMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { ledgerViewStyle, setLedgerViewStyle } = useUserPreferences();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="px-3 py-1.5 text-sm text-zinc-300 border border-zinc-700 rounded-md hover:bg-zinc-800 flex items-center gap-1"
      >
        View
        <span className="text-zinc-500 text-xs">▾</span>
      </button>

      {isOpen && (
        <div className="absolute right-0 z-50 mt-1 w-56 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl overflow-hidden">
          {/* View Mode Section */}
          <div className="py-1 border-b border-zinc-700">
            <div className="px-3 py-1 text-xs text-zinc-500 uppercase tracking-wider">View Mode</div>
            {VIEW_MODES.map(mode => (
              <button
                key={mode.value}
                type="button"
                onClick={() => {
                  setLedgerViewStyle(mode.value);
                  setIsOpen(false);
                }}
                className="w-full px-3 py-2 text-sm text-left hover:bg-zinc-700 flex justify-between items-center"
              >
                <span className={ledgerViewStyle === mode.value ? 'text-zinc-100' : 'text-zinc-400'}>
                  {ledgerViewStyle === mode.value ? '●' : '○'} {mode.label}
                </span>
                <span className="text-zinc-600 text-xs font-mono">{mode.shortcut}</span>
              </button>
            ))}
          </div>

          {/* Toggles Section */}
          <div className="py-1">
            {hasSubaccounts && (
              <button
                type="button"
                onClick={() => {
                  onToggleSubaccounts();
                  setIsOpen(false);
                }}
                className="w-full px-3 py-2 text-sm text-left text-zinc-300 hover:bg-zinc-700 flex items-center gap-2"
              >
                <span>{showSubaccounts ? '☑' : '☐'}</span>
                Sub-Accounts
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onToggleUnreviewed();
                setIsOpen(false);
              }}
              className="w-full px-3 py-2 text-sm text-left text-zinc-300 hover:bg-zinc-700 flex items-center gap-2"
            >
              <span>{showUnreviewedOnly ? '☑' : '☐'}</span>
              Unreviewed Only
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ViewMenu.tsx
git commit -m "feat: add ViewMenu dropdown component for ledger view modes and toggles"
```

---

### Task 4: Create SplitRows Component

**Files:**
- Create: `src/components/ledger/SplitRows.tsx`

- [ ] **Step 1: Create the split rows rendering component**

This component renders the individual split detail rows beneath a transaction row. Used by Transaction Journal (always), Auto-Split (when expanded), and Basic Ledger (when manually expanded).

```tsx
'use client';

import { formatCurrency } from '@/lib/format';

// Import the Split type from the project's types instead of re-declaring
// import { Split } from '@/lib/types';
// If the project's Split type doesn't have value_decimal/quantity_decimal,
// extend it or use the AccountTransaction's split sub-type from src/components/ledger/types.ts
interface SplitDisplay {
  guid: string;
  account_name: string;
  account_fullname: string;
  memo: string;
  value_decimal: number;
  quantity_decimal: number;
  account_guid: string;
}

interface SplitRowsProps {
  splits: SplitDisplay[];
  currencyMnemonic: string;
  columns: number; // Total columns in the table for proper spanning
}

// IMPORTANT: Pass ALL splits including the account's own split.
// Do NOT filter out splits where account_guid === current account.
// The spec requires the account's own split to appear both in the
// transaction row (summarized) and as a split row (detailed).

export default function SplitRows({ splits, currencyMnemonic, columns }: SplitRowsProps) {
  return (
    <>
      {splits.map(split => {
        const isDebit = split.value_decimal > 0;
        const absValue = Math.abs(split.value_decimal);

        return (
          <tr key={split.guid} className="bg-zinc-900/50 border-b border-zinc-800/50">
            {/* Empty date column */}
            <td className="px-3 py-1.5" />
            {/* Memo in description column */}
            <td className="px-3 py-1.5 pl-8 text-xs text-zinc-500">
              {split.memo || ''}
            </td>
            {/* Account path in transfer column */}
            <td className="px-3 py-1.5 text-xs text-blue-400">
              {split.account_fullname || split.account_name}
            </td>
            {/* Debit */}
            <td className="px-3 py-1.5 text-right text-xs text-zinc-400">
              {isDebit ? formatCurrency(absValue, currencyMnemonic) : ''}
            </td>
            {/* Credit */}
            <td className="px-3 py-1.5 text-right text-xs text-zinc-400">
              {!isDebit ? formatCurrency(absValue, currencyMnemonic) : ''}
            </td>
            {/* Empty balance column */}
            <td className="px-3 py-1.5" />
          </tr>
        );
      })}
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ledger/SplitRows.tsx
git commit -m "feat: add SplitRows component for rendering split detail rows"
```

---

### Task 5: Create BalancingRow Component

**Files:**
- Create: `src/components/ledger/BalancingRow.tsx`

- [ ] **Step 1: Create the edit-mode balancing row component**

This row appears below splits when a transaction is focused in edit mode. It auto-calculates the imbalance and lets the user add a new split.

```tsx
'use client';

import { useState, useMemo } from 'react';
import { formatCurrency } from '@/lib/format';

interface Split {
  value_decimal: number;
}

interface BalancingRowProps {
  splits: Split[];
  currencyMnemonic: string;
  transactionGuid: string;
  onAddSplit: (accountGuid: string, amount: number) => void;
}

export default function BalancingRow({
  splits,
  currencyMnemonic,
  transactionGuid,
  onAddSplit,
}: BalancingRowProps) {
  const [selectedAccountGuid, setSelectedAccountGuid] = useState('');

  const imbalance = useMemo(() => {
    return splits.reduce((sum, s) => sum + s.value_decimal, 0);
  }, [splits]);

  // If balanced, don't show the balancing row
  // After a split is added via onAddSplit, the parent should refresh splits.
  // If still imbalanced, this component re-renders with updated splits and shows a new blank row.
  if (Math.abs(imbalance) < 0.001) return null;

  const balancingAmount = -imbalance;
  const isDebit = balancingAmount > 0;
  const absAmount = Math.abs(balancingAmount);

  return (
    <tr className="bg-green-950/30 border-b border-zinc-800/50 border-l-2 border-l-green-500">
      {/* Empty date */}
      <td className="px-3 py-1.5" />
      {/* Placeholder description */}
      <td className="px-3 py-1.5 pl-8 text-xs text-green-400 italic">
        New split...
      </td>
      {/* Account selector */}
      <td className="px-3 py-1.5">
        {/* Reuse existing AccountCell or a simple select — implementation will use the existing account selector pattern from EditableRow */}
        <input
          type="text"
          placeholder="Select account"
          value={selectedAccountGuid}
          onChange={e => setSelectedAccountGuid(e.target.value)}
          className="w-full px-2 py-0.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-green-400 focus:border-green-500 focus:outline-none"
        />
      </td>
      {/* Debit */}
      <td className="px-3 py-1.5 text-right text-xs text-green-400">
        {isDebit ? formatCurrency(absAmount, currencyMnemonic) : ''}
      </td>
      {/* Credit */}
      <td className="px-3 py-1.5 text-right text-xs text-green-400">
        {!isDebit ? formatCurrency(absAmount, currencyMnemonic) : ''}
      </td>
      {/* Empty balance */}
      <td className="px-3 py-1.5" />
    </tr>
  );
}
```

Note: The account selector in this component should be refined during implementation to use the existing `AccountCell` component pattern from `EditableRow.tsx` for consistency. The text input above is a placeholder for the plan — the implementer should use the same account autocomplete/dropdown used elsewhere.

- [ ] **Step 2: Commit**

```bash
git add src/components/ledger/BalancingRow.tsx
git commit -m "feat: add BalancingRow component for edit-mode split balancing"
```

---

### Task 6: Add Expand Arrow Column to Basic Ledger

**Files:**
- Modify: `src/components/ledger/columns.tsx`

- [ ] **Step 1: Add an expand toggle column as the first data column**

In `getColumns()`, add a new column at the beginning (after the checkbox column, before reconcile state):

```typescript
// Expand/collapse arrow for basic ledger view
{
  id: 'expand',
  header: '',
  size: 28,
  cell: ({ row }) => null, // Rendered by AccountLedger based on view mode
  meta: { isExpandColumn: true },
},
```

The actual arrow rendering will be handled in `AccountLedger.tsx` since it needs access to the expanded state. The column definition just reserves the space.

- [ ] **Step 2: Commit**

```bash
git add src/components/ledger/columns.tsx
git commit -m "feat: add expand arrow column definition for basic ledger view"
```

---

### Task 7: Integrate View Modes into AccountLedger

**Files:**
- Modify: `src/components/AccountLedger.tsx`

This is the largest task. It modifies AccountLedger to:
1. Read `ledgerViewStyle` from preferences
2. Register `v b`, `v j`, `v a` keyboard shortcuts
3. Replace standalone sub-accounts and unreviewed-only buttons with ViewMenu
4. Render split rows based on view mode
5. Handle expand/collapse in basic mode (arrow + right/left keys)
6. Handle auto-expand in autosplit mode (on focus change)

- [ ] **Step 1: Add view mode state and imports**

Add imports at the top:
```typescript
import ViewMenu from './ViewMenu';
import SplitRows from './ledger/SplitRows';
import BalancingRow from './ledger/BalancingRow';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut';
```

In the component body, read the preference:
```typescript
const { ledgerViewStyle, setLedgerViewStyle } = useUserPreferences();
```

Add expanded transactions state (for basic mode manual expand):
```typescript
const [expandedTransactions, setExpandedTransactions] = useState<Set<string>>(new Set());
```

- [ ] **Step 2: Register view mode keyboard shortcuts**

Using `useKeyboardShortcut`, register the chord shortcuts:
```typescript
useKeyboardShortcut('view-basic', 'v b', 'Basic Ledger view', () => setLedgerViewStyle('basic'), 'global');
useKeyboardShortcut('view-journal', 'v j', 'Transaction Journal view', () => setLedgerViewStyle('journal'), 'global');
useKeyboardShortcut('view-autosplit', 'v a', 'Auto-Split view', () => setLedgerViewStyle('autosplit'), 'global');
```

- [ ] **Step 3: Replace toolbar buttons with ViewMenu**

In the toolbar rendering section (~lines 1132-1229), remove the standalone sub-accounts toggle button and the unreviewed-only toggle button. Replace with:
```tsx
<ViewMenu
  showSubaccounts={showSubaccounts}
  onToggleSubaccounts={() => setShowSubaccounts(!showSubaccounts)}
  showUnreviewedOnly={showUnreviewedOnly}
  onToggleUnreviewed={() => setShowUnreviewedOnly(!showUnreviewedOnly)}
  hasSubaccounts={hasSubaccountData}
/>
```

- [ ] **Step 4: Add expand/collapse keyboard handling**

In `handleTableKeyDown` (~lines 712-974), add handling for Right/Left arrow keys. Note: ArrowRight/ArrowLeft are NOT currently handled in `handleTableKeyDown` — there is no existing column navigation conflict. We scope to first column to leave room for future column navigation:

```typescript
// Right arrow: expand transaction (only in basic mode, first column)
if (event.key === 'ArrowRight' && ledgerViewStyle === 'basic' && focusedColumnIndex === 0) {
  const tx = transactions[focusedRowIndex];
  if (tx && !expandedTransactions.has(tx.guid)) {
    setExpandedTransactions(prev => new Set(prev).add(tx.guid));
    event.preventDefault();
    return;
  }
}

// Left arrow: collapse transaction (only in basic mode, first column)
if (event.key === 'ArrowLeft' && ledgerViewStyle === 'basic' && focusedColumnIndex === 0) {
  const tx = transactions[focusedRowIndex];
  if (tx && expandedTransactions.has(tx.guid)) {
    setExpandedTransactions(prev => {
      const next = new Set(prev);
      next.delete(tx.guid);
      return next;
    });
    event.preventDefault();
    return;
  }
}
```

- [ ] **Step 5: Modify row rendering to support view modes**

After each transaction row in the table body, conditionally render split rows:

```tsx
{/* After each transaction row */}
{(() => {
  const showSplits =
    ledgerViewStyle === 'journal' ||
    (ledgerViewStyle === 'autosplit' && focusedRowIndex === index) ||
    (ledgerViewStyle === 'basic' && expandedTransactions.has(transaction.guid));

  if (!showSplits) return null;

  return (
    <>
      <SplitRows
        splits={transaction.splits}
        currencyMnemonic={transaction.commodity_mnemonic || 'USD'}
        columns={columns.length}
      />
      {isEditMode && (focusedRowIndex === index || ledgerViewStyle === 'journal') && (
        <BalancingRow
          splits={transaction.splits}
          currencyMnemonic={transaction.commodity_mnemonic || 'USD'}
          transactionGuid={transaction.guid}
          onAddSplit={(accountGuid, amount) => {
            // Call transaction update API to add new split
            handleAddSplit(transaction.guid, accountGuid, amount);
          }}
        />
      )}
    </>
  );
})()}
```

- [ ] **Step 6: Add expand arrow rendering for basic mode**

In the row rendering, for basic mode, render the expand arrow in the expand column:

```tsx
{ledgerViewStyle === 'basic' && (
  <td
    className="px-1 py-2 cursor-pointer text-zinc-500 hover:text-zinc-300 w-7"
    onClick={() => {
      setExpandedTransactions(prev => {
        const next = new Set(prev);
        if (next.has(transaction.guid)) {
          next.delete(transaction.guid);
        } else {
          next.add(transaction.guid);
        }
        return next;
      });
    }}
  >
    {transaction.splits && transaction.splits.length > 1 ? (
      expandedTransactions.has(transaction.guid) ? '▼' : '▶'
    ) : null}
  </td>
)}
```

- [ ] **Step 7: Handle auto-split collapse on focus change**

When `focusedRowIndex` changes and view mode is `autosplit`, the previously focused transaction should collapse automatically. This is handled naturally by the conditional rendering in Step 5 — only the focused row expands.

Add a CSS transition for smooth expand/collapse. Use a wrapper `<tbody>` with `transition-all` or animate row height.

- [ ] **Step 8: Add handleAddSplit function**

Add a handler for the BalancingRow's onAddSplit:

```typescript
const handleAddSplit = async (transactionGuid: string, accountGuid: string, amount: number) => {
  // Use existing PUT /api/transactions/[guid] endpoint
  // Fetch the full transaction, add the new split, and save
  try {
    const res = await fetch(`/api/transactions/${transactionGuid}`);
    const txData = await res.json();
    // Add new split to the transaction
    // Call PUT with updated splits
    // Refresh transaction list
    await refreshTransactions();
  } catch (err) {
    console.error('Failed to add split:', err);
  }
};
```

The exact implementation depends on the PUT API's expected request format. Check `src/app/api/transactions/[guid]/route.ts` PUT handler for the expected split structure.

- [ ] **Step 9: Verify all three view modes**

Run: `npm run dev`
Test:
- Basic Ledger: expand/collapse arrows work, right/left keyboard, multiple open
- Transaction Journal: all splits visible, balancing row in edit mode
- Auto-Split: expands on focus, collapses on blur
- View menu: switches modes, toggles sub-accounts and unreviewed
- `v b`, `v j`, `v a` keyboard shortcuts work
- `g d`, `g a` etc. still work (chord system backwards compatible)

- [ ] **Step 10: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: implement three transaction view modes (basic/journal/auto-split)"
```
