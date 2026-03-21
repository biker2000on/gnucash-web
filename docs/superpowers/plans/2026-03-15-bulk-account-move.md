# Bulk Account Reassignment — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to multi-select transactions in edit mode and reassign their splits from the current account to a different target account.

**Architecture:** Add a "Move to Account" button to the edit mode toolbar, create an account picker dialog, and a new bulk move API endpoint. Reuse existing multi-select checkbox infrastructure.

**Tech Stack:** React 19, TypeScript, Next.js API routes, Prisma

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/app/api/splits/bulk/move/route.ts` | Bulk split account reassignment endpoint |
| Create | `src/components/AccountPickerDialog.tsx` | Searchable account hierarchy picker modal |
| Modify | `src/components/AccountLedger.tsx` | Add "Move to Account" button, split GUID resolution |

---

### Task 1: Create Bulk Move API Endpoint

**Files:**
- Create: `src/app/api/splits/bulk/move/route.ts`

- [ ] **Step 1: Create the endpoint**

Follow the pattern from `src/app/api/splits/bulk/reconcile/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';

export async function POST(request: NextRequest) {
  const roleResult = await requireRole('edit');
  if (roleResult instanceof NextResponse) return roleResult;

  try {
  const body = await request.json();
  const { splitGuids, targetAccountGuid } = body;

  // Validation
  if (!splitGuids || !Array.isArray(splitGuids) || splitGuids.length === 0) {
    return NextResponse.json({ error: 'splitGuids array is required' }, { status: 400 });
  }
  if (!targetAccountGuid || typeof targetAccountGuid !== 'string') {
    return NextResponse.json({ error: 'targetAccountGuid is required' }, { status: 400 });
  }

  // Verify target account exists
  const targetAccount = await prisma.accounts.findUnique({
    where: { guid: targetAccountGuid },
    select: { guid: true, commodity_guid: true },
  });
  if (!targetAccount) {
    return NextResponse.json({ error: 'Target account not found' }, { status: 404 });
  }

  // Verify all splits exist and have the same commodity_guid as target
  // Note: Prisma relation name is `account` (singular), not `accounts`
  // Verify against prisma/schema.prisma before implementation
  const splits = await prisma.splits.findMany({
    where: { guid: { in: splitGuids } },
    include: { account: { select: { commodity_guid: true } } },
  });

  if (splits.length !== splitGuids.length) {
    return NextResponse.json({ error: 'Some splits not found' }, { status: 404 });
  }

  const incompatible = splits.filter(
    s => s.account?.commodity_guid !== targetAccount.commodity_guid
  );
  if (incompatible.length > 0) {
    return NextResponse.json(
      { error: 'Cannot move splits across different currencies' },
      { status: 400 }
    );
  }

  // Perform the bulk update
  const result = await prisma.splits.updateMany({
    where: { guid: { in: splitGuids } },
    data: { account_guid: targetAccountGuid },
  });

  return NextResponse.json({
    success: true,
    updated: result.count,
  });
  } catch (err) {
    console.error('Failed to bulk move splits:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/splits/bulk/move/route.ts
git commit -m "feat: add bulk split account move API endpoint"
```

---

### Task 2: Create AccountPickerDialog Component

**Files:**
- Create: `src/components/AccountPickerDialog.tsx`

- [ ] **Step 1: Create the account picker modal**

```tsx
'use client';

import { useState, useEffect, useMemo } from 'react';
// Note: There is no generic Modal component in this project.
// Check how existing modals are built (e.g., BookEditorModal.tsx, TransactionFormModal.tsx)
// and use the same pattern — likely a raw <dialog> element or a custom modal wrapper.
// The implementer should examine the codebase's modal pattern and follow it.

interface Account {
  guid: string;
  name: string;
  account_fullname: string;
  account_type: string;
  commodity_guid: string;
}

interface AccountPickerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (accountGuid: string, accountName: string) => void;
  excludeAccountGuid?: string; // Current account to exclude from list
  commodityGuid?: string; // Filter to same currency only
  title?: string;
}

export default function AccountPickerDialog({
  isOpen,
  onClose,
  onSelect,
  excludeAccountGuid,
  commodityGuid,
  title = 'Select Account',
}: AccountPickerDialogProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    fetch('/api/accounts')
      .then(res => res.json())
      .then(data => {
        setAccounts(data.accounts || data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [isOpen]);

  const filtered = useMemo(() => {
    let result = accounts;
    if (excludeAccountGuid) {
      result = result.filter(a => a.guid !== excludeAccountGuid);
    }
    if (commodityGuid) {
      result = result.filter(a => a.commodity_guid === commodityGuid);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        a =>
          a.name.toLowerCase().includes(q) ||
          (a.account_fullname && a.account_fullname.toLowerCase().includes(q))
      );
    }
    return result;
  }, [accounts, excludeAccountGuid, commodityGuid, search]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="md">
      <div className="space-y-3">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search accounts..."
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-md text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
          autoFocus
        />

        <div className="max-h-72 overflow-y-auto border border-zinc-700 rounded-md">
          {loading ? (
            <div className="p-4 text-center text-zinc-500 text-sm">Loading...</div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-center text-zinc-500 text-sm">No matching accounts</div>
          ) : (
            filtered.map(account => (
              <button
                key={account.guid}
                type="button"
                onClick={() => {
                  onSelect(account.guid, account.account_fullname || account.name);
                  onClose();
                }}
                className="w-full px-3 py-2 text-sm text-left text-zinc-200 hover:bg-zinc-700 border-b border-zinc-800 last:border-0"
              >
                <div>{account.account_fullname || account.name}</div>
                <div className="text-xs text-zinc-500">{account.account_type}</div>
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AccountPickerDialog.tsx
git commit -m "feat: add AccountPickerDialog for selecting target account"
```

---

### Task 3: Add Move to Account Button to AccountLedger

**Files:**
- Modify: `src/components/AccountLedger.tsx`

- [ ] **Step 1: Add state for the account picker dialog**

```typescript
const [showMoveDialog, setShowMoveDialog] = useState(false);
```

- [ ] **Step 2: Add the "Move to Account" button in the edit mode toolbar**

In the edit mode toolbar section (where "Delete Selected" button exists, ~lines 1177-1207), add alongside it:

```tsx
{editSelectedGuids.size > 0 && (
  <button
    onClick={() => setShowMoveDialog(true)}
    className="px-3 py-1.5 text-sm text-blue-400 border border-blue-500/30 rounded-md hover:bg-blue-500/10"
  >
    Move to Account ({editSelectedGuids.size})
  </button>
)}
```

- [ ] **Step 3: Add the move handler**

```typescript
const handleBulkMove = async (targetAccountGuid: string, targetAccountName: string) => {
  // Resolve transaction GUIDs to split GUIDs
  const splitGuids: string[] = [];
  transactions.forEach(tx => {
    if (editSelectedGuids.has(tx.guid)) {
      // Collect all splits belonging to current account (per-transaction)
      let foundSplits = false;
      tx.splits?.forEach(split => {
        if (split.account_guid === accountGuid) {
          splitGuids.push(split.guid);
          foundSplits = true;
        }
      });
      // Fallback to account_split_guid if splits not loaded for THIS transaction
      if (!foundSplits && tx.account_split_guid) {
        splitGuids.push(tx.account_split_guid);
      }
    }
  });

  if (splitGuids.length === 0) return;

  try {
    const res = await fetch('/api/splits/bulk/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ splitGuids, targetAccountGuid }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to move splits');
    }

    const data = await res.json();
    // Clear selection and refresh
    setEditSelectedGuids(new Set());
    await refreshTransactions();
    // Show toast or notification
    console.log(`Moved ${data.updated} splits to ${targetAccountName}`);
  } catch (err) {
    console.error('Failed to move splits:', err);
  }
};
```

- [ ] **Step 4: Render the AccountPickerDialog**

At the bottom of the component's JSX, add:

```tsx
<AccountPickerDialog
  isOpen={showMoveDialog}
  onClose={() => setShowMoveDialog(false)}
  onSelect={(guid, name) => {
    handleBulkMove(guid, name);
    setShowMoveDialog(false);
  }}
  excludeAccountGuid={accountGuid}
  commodityGuid={accountCommodityGuid}
  title={`Move ${editSelectedGuids.size} transaction(s) to...`}
/>
```

**IMPORTANT**: `accountCommodityGuid` is not currently available in AccountLedger's state. The component has `commodityNamespace` but not `commodity_guid`. To resolve this:
- Check the account info API call (likely `/api/accounts/[guid]/info`) — if it returns `commodity_guid`, store it in component state
- If not, add `commodity_guid` to the account info API response and store it when the account loads
- This is a required prerequisite for the commodity validation to work

- [ ] **Step 5: Verify the flow**

Run: `npm run dev`
Test:
- Enter edit mode → select transactions → "Move to Account" button appears
- Click → account picker dialog opens, filtered to same currency
- Select target → splits moved, transactions disappear from current ledger
- Shift-click multi-select works with the move action

- [ ] **Step 6: Commit**

```bash
git add src/components/AccountLedger.tsx src/components/AccountPickerDialog.tsx
git commit -m "feat: add bulk account move functionality to edit mode"
```
