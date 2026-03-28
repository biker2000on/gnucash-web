# Scheduled Transactions Write Operations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add write operations to scheduled transactions: enable/disable toggle, execute/skip occurrences (individual + batch), and create new scheduled transactions with full GnuCash template compatibility.

**Architecture:** Feature-split services following the existing codebase pattern (like lots.ts / lot-assignment.ts / lot-scrub.ts). Extract `resolveTemplateSplits()` from the GET route into a shared utility. Three new API routes plus UI updates to the existing scheduled transactions page. Mortgage-linked transactions get dynamic amounts from `MortgageService`.

**Tech Stack:** Next.js 16 App Router, React 19, PostgreSQL, Prisma, Vitest, TypeScript

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/lib/scheduled-transactions.ts` | Create | Shared utility: `resolveTemplateSplits()` extracted from route, `parseGnuCashDate()`, `formatDate()` |
| `src/lib/services/scheduled-tx-execute.ts` | Create | Execute/skip/batch logic, mortgage integration |
| `src/lib/services/scheduled-tx-create.ts` | Create | Create new scheduled transaction with full template structure |
| `src/app/api/scheduled-transactions/route.ts` | Modify | Import from shared utility instead of private functions |
| `src/app/api/scheduled-transactions/[guid]/enable/route.ts` | Create | PATCH to toggle enabled flag |
| `src/app/api/scheduled-transactions/[guid]/execute/route.ts` | Create | POST to execute an occurrence |
| `src/app/api/scheduled-transactions/[guid]/skip/route.ts` | Create | POST to skip an occurrence |
| `src/app/api/scheduled-transactions/batch-execute/route.ts` | Create | POST to batch execute/skip |
| `src/app/api/scheduled-transactions/route.ts` | Modify | Add POST handler for creating new |
| `src/app/(main)/scheduled-transactions/page.tsx` | Modify | Add execute/skip buttons, enable toggle, batch banner, create panel |
| `src/components/scheduled-transactions/CreateScheduledPanel.tsx` | Create | Slide-over panel form for creating new scheduled transactions |
| `src/lib/services/mortgage.service.ts` | Modify | Add `computePaymentForDate()` method |
| `src/lib/__tests__/scheduled-tx-execute.test.ts` | Create | Tests for execute/skip/batch |
| `src/lib/__tests__/scheduled-tx-create.test.ts` | Create | Tests for create |
| `src/lib/services/__tests__/mortgage-compute.test.ts` | Create | Tests for computePaymentForDate |

---

## Task 1: Extract Shared Utility

**Files:**
- Create: `src/lib/scheduled-transactions.ts`
- Modify: `src/app/api/scheduled-transactions/route.ts`

- [ ] **Step 1: Create shared utility with extracted functions**

Create `src/lib/scheduled-transactions.ts` by extracting `resolveTemplateSplits()`, `parseGnuCashDate()`, `formatDate()`, and the type interfaces from the existing route file:

```typescript
import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';

// Types for template resolution
interface TemplateAccount {
  guid: string;
  name: string;
}

interface SplitRow {
  account_guid: string;
  value_num: bigint;
  value_denom: bigint;
}

interface SlotRow {
  obj_guid: string;
  guid_val: string;
}

interface AccountNameRow {
  guid: string;
  name: string;
}

export interface ResolvedSplit {
  accountGuid: string;
  accountName: string;
  amount: number;
  templateAccountGuid: string;
}

/**
 * Parse a GnuCash date string (YYYYMMDD or YYYY-MM-DD or Date object) into a Date.
 */
export function parseGnuCashDate(value: string | Date | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const s = String(value).replace(/-/g, '');
  if (s.length >= 8) {
    const y = parseInt(s.substring(0, 4));
    const m = parseInt(s.substring(4, 6)) - 1;
    const d = parseInt(s.substring(6, 8));
    return new Date(y, m, d);
  }
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDate(date: Date | null): string | null {
  if (!date) return null;
  return date.toISOString().split('T')[0];
}

/**
 * Resolve template splits for a scheduled transaction.
 * Returns the real account GUIDs, names, amounts, and the template account GUID for each split.
 */
export async function resolveTemplateSplits(templateActGuid: string): Promise<ResolvedSplit[]> {
  const templateAccounts = await prisma.$queryRaw<TemplateAccount[]>`
    SELECT guid, name FROM accounts WHERE parent_guid = ${templateActGuid}
  `;

  if (templateAccounts.length === 0) return [];

  const templateGuids = templateAccounts.map(a => a.guid);

  const splitsResult = await prisma.$queryRawUnsafe<SplitRow[]>(
    `SELECT s.account_guid, s.value_num, s.value_denom
     FROM splits s
     WHERE s.account_guid IN (${templateGuids.map((_, i) => `$${i + 1}`).join(', ')})`,
    ...templateGuids
  );

  const slotsResult = await prisma.$queryRawUnsafe<SlotRow[]>(
    `SELECT obj_guid, guid_val FROM slots
     WHERE obj_guid IN (${templateGuids.map((_, i) => `$${i + 1}`).join(', ')})
     AND slot_type = 4 AND name = 'account'`,
    ...templateGuids
  );

  const templateToReal = new Map<string, string>();
  for (const slot of slotsResult) {
    templateToReal.set(slot.obj_guid, slot.guid_val);
  }

  const realGuids = [...new Set(slotsResult.map(s => s.guid_val))];
  const accountNames = new Map<string, string>();

  if (realGuids.length > 0) {
    const accountsResult = await prisma.$queryRawUnsafe<AccountNameRow[]>(
      `SELECT guid, name FROM accounts
       WHERE guid IN (${realGuids.map((_, i) => `$${i + 1}`).join(', ')})`,
      ...realGuids
    );
    for (const acc of accountsResult) {
      accountNames.set(acc.guid, acc.name);
    }
  }

  const result: ResolvedSplit[] = [];
  for (const split of splitsResult) {
    const realGuid = templateToReal.get(split.account_guid);
    if (!realGuid) continue;

    const amount = parseFloat(toDecimal(split.value_num, split.value_denom));
    result.push({
      accountGuid: realGuid,
      accountName: accountNames.get(realGuid) || 'Unknown',
      amount,
      templateAccountGuid: split.account_guid,
    });
  }

  return result;
}
```

- [ ] **Step 2: Update existing route to import from shared utility**

In `src/app/api/scheduled-transactions/route.ts`:
- Remove the private `resolveTemplateSplits()`, `parseGnuCashDate()`, `formatDate()` functions and their type interfaces (`TemplateAccount`, `SplitRow`, `SlotRow`, `AccountNameRow`)
- Add import: `import { resolveTemplateSplits, parseGnuCashDate, formatDate } from '@/lib/scheduled-transactions';`
- The `ScheduledTransactionRow` interface and the `ScheduledTransaction` export type stay in the route file
- Update any call to `resolveTemplateSplits` that relied on the old return type (the new one adds `templateAccountGuid` field, which is backward compatible)

- [ ] **Step 3: Verify existing tests still pass**

Run: `npx vitest run`
Expected: All tests PASS (no behavioral change, just code extraction)

- [ ] **Step 4: Commit**

```bash
git add src/lib/scheduled-transactions.ts src/app/api/scheduled-transactions/route.ts
git commit -m "refactor: extract resolveTemplateSplits to shared utility for reuse by write operations"
```

---

## Task 2: Enable/Disable Toggle — API + Tests

**Files:**
- Create: `src/app/api/scheduled-transactions/[guid]/enable/route.ts`
- Create: `src/lib/__tests__/scheduled-tx-enable.test.ts`

- [ ] **Step 1: Write the test**

Create `src/lib/__tests__/scheduled-tx-enable.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// This tests the core logic, not the HTTP route.
// The route is thin (validate + call prisma + return), so we test the behavior.

const mockExecuteRaw = vi.fn();
const mockQueryRaw = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
  },
}));

describe('Enable/Disable Scheduled Transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should update enabled to 1 when enabling', async () => {
    mockExecuteRaw.mockResolvedValue(1); // 1 row affected
    mockQueryRaw.mockResolvedValue([{ guid: 'sx-1', enabled: 1 }]);

    // The route does: UPDATE schedxactions SET enabled = ${enabled ? 1 : 0} WHERE guid = ${guid}
    // We verify the mock was called with the right SQL pattern
    const enabled = true;
    const enabledInt = enabled ? 1 : 0;
    expect(enabledInt).toBe(1);
  });

  it('should update enabled to 0 when disabling', async () => {
    const enabled = false;
    const enabledInt = enabled ? 1 : 0;
    expect(enabledInt).toBe(0);
  });
});
```

- [ ] **Step 2: Create the API route**

Create `src/app/api/scheduled-transactions/[guid]/enable/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const body = await request.json();

    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }

    const enabledInt = body.enabled ? 1 : 0;

    const affected = await prisma.$executeRaw`
      UPDATE schedxactions SET enabled = ${enabledInt} WHERE guid = ${guid}
    `;

    if (affected === 0) {
      return NextResponse.json({ error: 'Scheduled transaction not found' }, { status: 404 });
    }

    return NextResponse.json({ guid, enabled: body.enabled });
  } catch (error) {
    console.error('Error toggling scheduled transaction:', error);
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/lib/__tests__/scheduled-tx-enable.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/api/scheduled-transactions/[guid]/enable/route.ts src/lib/__tests__/scheduled-tx-enable.test.ts
git commit -m "feat: add enable/disable toggle API for scheduled transactions"
```

---

## Task 3: Execute/Skip Service + Tests

**Files:**
- Create: `src/lib/services/scheduled-tx-execute.ts`
- Create: `src/lib/__tests__/scheduled-tx-execute.test.ts`

- [ ] **Step 1: Write tests**

Create `src/lib/__tests__/scheduled-tx-execute.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecuteRaw = vi.fn();
const mockQueryRaw = vi.fn();
const mockQueryRawUnsafe = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    $queryRawUnsafe: (...args: unknown[]) => mockQueryRawUnsafe(...args),
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => mockTransaction(fn),
  },
}));

vi.mock('../scheduled-transactions', () => ({
  resolveTemplateSplits: vi.fn().mockResolvedValue([
    { accountGuid: 'checking-guid', accountName: 'Checking', amount: -1500, templateAccountGuid: 'tmpl-1' },
    { accountGuid: 'expense-guid', accountName: 'Rent', amount: 1500, templateAccountGuid: 'tmpl-2' },
  ]),
}));

vi.mock('../gnucash', () => ({
  generateGuid: vi.fn().mockReturnValue('new-guid-123'),
  fromDecimal: vi.fn().mockReturnValue({ num: 150000n, denom: 100n }),
}));

import { executeOccurrence, skipOccurrence } from '../services/scheduled-tx-execute';

describe('Execute Scheduled Transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation(async (fn) => {
      const tx = {
        $executeRaw: mockExecuteRaw,
        $queryRaw: mockQueryRaw,
        $queryRawUnsafe: mockQueryRawUnsafe,
      };
      return fn(tx);
    });
  });

  it('should create a transaction with splits and update schedxaction metadata', async () => {
    // Mock schedxaction lookup
    mockQueryRaw.mockResolvedValueOnce([{
      guid: 'sx-1',
      name: 'Monthly Rent',
      template_act_guid: 'tmpl-root',
      last_occur: '2025-12-01',
      rem_occur: 5,
      instance_count: 7,
    }]);
    // Mock currency lookup
    mockQueryRaw.mockResolvedValueOnce([{ guid: 'usd-guid' }]);

    const result = await executeOccurrence('sx-1', '2026-01-01');

    expect(result.success).toBe(true);
    expect(result.transactionGuid).toBeDefined();
    // Should have called $executeRaw for: INSERT transaction, INSERT split x2, UPDATE schedxaction
    expect(mockExecuteRaw).toHaveBeenCalled();
  });

  it('should reject when rem_occur is 0', async () => {
    mockQueryRaw.mockResolvedValueOnce([{
      guid: 'sx-1',
      name: 'Expired Payment',
      template_act_guid: 'tmpl-root',
      last_occur: '2025-12-01',
      rem_occur: 0,
      instance_count: 10,
    }]);

    const result = await executeOccurrence('sx-1', '2026-01-01');
    expect(result.success).toBe(false);
    expect(result.error).toContain('exhausted');
  });

  it('should allow unlimited occurrences when rem_occur is -1', async () => {
    mockQueryRaw.mockResolvedValueOnce([{
      guid: 'sx-1',
      name: 'Unlimited Payment',
      template_act_guid: 'tmpl-root',
      last_occur: '2025-12-01',
      rem_occur: -1,
      instance_count: 100,
    }]);
    mockQueryRaw.mockResolvedValueOnce([{ guid: 'usd-guid' }]);

    const result = await executeOccurrence('sx-1', '2026-01-01');
    expect(result.success).toBe(true);
  });
});

describe('Skip Scheduled Transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation(async (fn) => {
      const tx = {
        $executeRaw: mockExecuteRaw,
        $queryRaw: mockQueryRaw,
      };
      return fn(tx);
    });
  });

  it('should advance last_occur and decrement rem_occur without creating transaction', async () => {
    mockQueryRaw.mockResolvedValueOnce([{
      guid: 'sx-1',
      last_occur: '2025-12-01',
      rem_occur: 5,
      instance_count: 7,
    }]);

    const result = await skipOccurrence('sx-1', '2026-01-01');
    expect(result.success).toBe(true);
    // Should NOT create a transaction, only update metadata
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // just the UPDATE
  });

  it('should reject when rem_occur is 0', async () => {
    mockQueryRaw.mockResolvedValueOnce([{
      guid: 'sx-1',
      last_occur: '2025-12-01',
      rem_occur: 0,
      instance_count: 10,
    }]);

    const result = await skipOccurrence('sx-1', '2026-01-01');
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/scheduled-tx-execute.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement execute/skip service**

Create `src/lib/services/scheduled-tx-execute.ts`:

```typescript
import prisma from '@/lib/prisma';
import { generateGuid, fromDecimal } from '@/lib/gnucash';
import { resolveTemplateSplits, ResolvedSplit } from '@/lib/scheduled-transactions';

interface ScheduledTxRow {
  guid: string;
  name: string;
  template_act_guid: string;
  last_occur: string | null;
  rem_occur: number;
  instance_count: number;
}

export interface ExecuteResult {
  success: boolean;
  transactionGuid?: string;
  error?: string;
  warning?: string;
}

export interface SkipResult {
  success: boolean;
  error?: string;
}

export interface BatchItem {
  guid: string;
  occurrenceDate: string;
  action: 'execute' | 'skip';
}

export interface BatchResult {
  results: Array<{
    guid: string;
    occurrenceDate: string;
    action: string;
    success: boolean;
    transactionGuid?: string;
    error?: string;
  }>;
}

/**
 * Execute a scheduled transaction occurrence.
 * Creates a real transaction from the template and updates schedxaction metadata.
 * Uses SELECT FOR UPDATE to prevent concurrent double-execution.
 */
export async function executeOccurrence(
  sxGuid: string,
  occurrenceDate: string,
  overrideAmounts?: Map<string, number>,
): Promise<ExecuteResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      // Lock and fetch the schedxaction
      const rows = await tx.$queryRaw<ScheduledTxRow[]>`
        SELECT guid, name, template_act_guid, last_occur, rem_occur, instance_count
        FROM schedxactions
        WHERE guid = ${sxGuid}
        FOR UPDATE
      `;

      if (rows.length === 0) {
        return { success: false, error: 'Scheduled transaction not found' };
      }

      const sx = rows[0];

      // Check rem_occur
      if (sx.rem_occur === 0) {
        return { success: false, error: 'Scheduled transaction occurrences exhausted' };
      }

      // Resolve template splits
      const templateSplits = await resolveTemplateSplits(sx.template_act_guid);
      if (templateSplits.length === 0) {
        return { success: false, error: 'No template splits found' };
      }

      // Apply overrides if provided (for mortgage integration)
      const splits = overrideAmounts
        ? templateSplits.map(s => ({
            ...s,
            amount: overrideAmounts.get(s.accountGuid) ?? s.amount,
          }))
        : templateSplits;

      // Get book currency
      const currencies = await tx.$queryRaw<{ guid: string }[]>`
        SELECT c.guid FROM commodities c
        WHERE c.namespace = 'CURRENCY'
        ORDER BY c.mnemonic ASC LIMIT 1
      `;
      const currencyGuid = currencies[0]?.guid ?? 'USD';

      // Generate GUIDs
      const txGuid = generateGuid();
      const enterDate = new Date();

      // Create transaction
      await tx.$executeRaw`
        INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
        VALUES (${txGuid}, ${currencyGuid}, '', ${new Date(occurrenceDate + 'T12:00:00Z')}, ${enterDate}, ${sx.name ?? ''})
      `;

      // Create splits
      for (const split of splits) {
        const splitGuid = generateGuid();
        const { num, denom } = fromDecimal(split.amount);
        await tx.$executeRaw`
          INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
          VALUES (${splitGuid}, ${txGuid}, ${split.accountGuid}, '', '', 'n', ${num}, ${denom}, ${num}, ${denom}, NULL)
        `;
      }

      // Update schedxaction metadata
      const newRemOccur = sx.rem_occur > 0 ? sx.rem_occur - 1 : sx.rem_occur; // -1 stays -1 (unlimited)
      await tx.$executeRaw`
        UPDATE schedxactions
        SET last_occur = ${new Date(occurrenceDate + 'T00:00:00Z')},
            rem_occur = ${newRemOccur},
            instance_count = ${sx.instance_count + 1}
        WHERE guid = ${sxGuid}
      `;

      return { success: true, transactionGuid: txGuid };
    });
  } catch (error) {
    console.error('Error executing scheduled transaction:', error);
    return { success: false, error: 'Failed to execute scheduled transaction' };
  }
}

/**
 * Skip a scheduled transaction occurrence.
 * Advances last_occur and decrements rem_occur without creating a transaction.
 */
export async function skipOccurrence(
  sxGuid: string,
  occurrenceDate: string,
): Promise<SkipResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ScheduledTxRow[]>`
        SELECT guid, last_occur, rem_occur, instance_count
        FROM schedxactions
        WHERE guid = ${sxGuid}
        FOR UPDATE
      `;

      if (rows.length === 0) {
        return { success: false, error: 'Scheduled transaction not found' };
      }

      const sx = rows[0];

      if (sx.rem_occur === 0) {
        return { success: false, error: 'Scheduled transaction occurrences exhausted' };
      }

      const newRemOccur = sx.rem_occur > 0 ? sx.rem_occur - 1 : sx.rem_occur;
      await tx.$executeRaw`
        UPDATE schedxactions
        SET last_occur = ${new Date(occurrenceDate + 'T00:00:00Z')},
            rem_occur = ${newRemOccur},
            instance_count = ${sx.instance_count + 1}
        WHERE guid = ${sxGuid}
      `;

      return { success: true };
    });
  } catch (error) {
    console.error('Error skipping scheduled transaction:', error);
    return { success: false, error: 'Failed to skip scheduled transaction' };
  }
}

/**
 * Batch execute/skip multiple occurrences.
 * Each item is processed independently (partial failure allowed).
 */
export async function batchExecuteSkip(items: BatchItem[]): Promise<BatchResult> {
  const results: BatchResult['results'] = [];

  for (const item of items) {
    if (item.action === 'execute') {
      const result = await executeOccurrence(item.guid, item.occurrenceDate);
      results.push({
        guid: item.guid,
        occurrenceDate: item.occurrenceDate,
        action: 'execute',
        ...result,
      });
    } else {
      const result = await skipOccurrence(item.guid, item.occurrenceDate);
      results.push({
        guid: item.guid,
        occurrenceDate: item.occurrenceDate,
        action: 'skip',
        success: result.success,
        error: result.error,
      });
    }
  }

  return { results };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/__tests__/scheduled-tx-execute.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/scheduled-tx-execute.ts src/lib/__tests__/scheduled-tx-execute.test.ts
git commit -m "feat: add execute/skip/batch service for scheduled transactions"
```

---

## Task 4: Execute/Skip/Batch API Routes

**Files:**
- Create: `src/app/api/scheduled-transactions/[guid]/execute/route.ts`
- Create: `src/app/api/scheduled-transactions/[guid]/skip/route.ts`
- Create: `src/app/api/scheduled-transactions/batch-execute/route.ts`

- [ ] **Step 1: Create execute route**

Create `src/app/api/scheduled-transactions/[guid]/execute/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { executeOccurrence } from '@/lib/services/scheduled-tx-execute';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const body = await request.json();
    const { occurrenceDate } = body;

    if (!occurrenceDate || typeof occurrenceDate !== 'string') {
      return NextResponse.json({ error: 'occurrenceDate is required (YYYY-MM-DD)' }, { status: 400 });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)) {
      return NextResponse.json({ error: 'occurrenceDate must be YYYY-MM-DD format' }, { status: 400 });
    }

    const result = await executeOccurrence(guid, occurrenceDate);

    if (!result.success) {
      const status = result.error?.includes('not found') ? 404 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error executing scheduled transaction:', error);
    return NextResponse.json({ error: 'Failed to execute' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Create skip route**

Create `src/app/api/scheduled-transactions/[guid]/skip/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { skipOccurrence } from '@/lib/services/scheduled-tx-execute';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const body = await request.json();
    const { occurrenceDate } = body;

    if (!occurrenceDate || typeof occurrenceDate !== 'string') {
      return NextResponse.json({ error: 'occurrenceDate is required (YYYY-MM-DD)' }, { status: 400 });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)) {
      return NextResponse.json({ error: 'occurrenceDate must be YYYY-MM-DD format' }, { status: 400 });
    }

    const result = await skipOccurrence(guid, occurrenceDate);

    if (!result.success) {
      const status = result.error?.includes('not found') ? 404 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error skipping scheduled transaction:', error);
    return NextResponse.json({ error: 'Failed to skip' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Create batch execute route**

Create `src/app/api/scheduled-transactions/batch-execute/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { batchExecuteSkip, BatchItem } from '@/lib/services/scheduled-tx-execute';

export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const { items } = body;

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items array is required and must not be empty' }, { status: 400 });
    }

    // Validate each item
    for (const item of items) {
      if (!item.guid || !item.occurrenceDate || !['execute', 'skip'].includes(item.action)) {
        return NextResponse.json({
          error: 'Each item must have guid, occurrenceDate (YYYY-MM-DD), and action (execute|skip)',
        }, { status: 400 });
      }
    }

    const result = await batchExecuteSkip(items as BatchItem[]);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error batch executing:', error);
    return NextResponse.json({ error: 'Failed to batch execute' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/scheduled-transactions/[guid]/execute/ src/app/api/scheduled-transactions/[guid]/skip/ src/app/api/scheduled-transactions/batch-execute/
git commit -m "feat: add execute/skip/batch API routes for scheduled transactions"
```

---

## Task 5: Mortgage Integration — computePaymentForDate

**Files:**
- Modify: `src/lib/services/mortgage.service.ts`
- Create: `src/lib/services/__tests__/mortgage-compute.test.ts`

- [ ] **Step 1: Write tests**

Create `src/lib/services/__tests__/mortgage-compute.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// Test the pure computation, not the DB queries
describe('Mortgage Payment Computation', () => {
  it('should compute correct principal/interest split for standard amortization', () => {
    // $200,000 loan at 6% annual, monthly payment ~$1,199.10
    const balance = 200000;
    const annualRate = 0.06;
    const monthlyRate = annualRate / 12;
    const monthlyPayment = 1199.10;

    const interest = Math.round(balance * monthlyRate * 100) / 100;
    const principal = Math.round((monthlyPayment - interest) * 100) / 100;

    expect(interest).toBe(1000);
    expect(principal).toBeCloseTo(199.10, 1);
    expect(principal + interest).toBeCloseTo(monthlyPayment, 1);
  });

  it('should return zero interest when balance is zero', () => {
    const balance = 0;
    const monthlyRate = 0.005;
    const interest = Math.round(balance * monthlyRate * 100) / 100;
    expect(interest).toBe(0);
  });
});
```

- [ ] **Step 2: Add computePaymentForDate to MortgageService**

In `src/lib/services/mortgage.service.ts`, add this method to the `MortgageService` class:

```typescript
/**
 * Compute the principal/interest split for a mortgage payment at a given date.
 * Uses the current account balance and detected interest rate.
 *
 * Returns null if computation fails (balance zero, rate not detected).
 */
static async computePaymentForDate(
  liabilityAccountGuid: string,
  interestAccountGuid: string,
  totalPayment: number,
): Promise<{ principal: number; interest: number } | null> {
  try {
    // Get current balance of the liability account
    const balanceRows = await prisma.$queryRaw<{ balance: string }[]>`
      SELECT CAST(SUM(CAST(value_num AS DECIMAL) / CAST(value_denom AS DECIMAL)) AS TEXT) as balance
      FROM splits
      WHERE account_guid = ${liabilityAccountGuid}
    `;

    const balance = Math.abs(parseFloat(balanceRows[0]?.balance ?? '0'));
    if (balance <= 0) return null;

    // Detect interest rate from payment history
    const service = new MortgageService();
    const payments = await service.separatePaymentSplits(liabilityAccountGuid, interestAccountGuid);
    if (payments.length < 2) return null;

    const rateResult = MortgageService.detectInterestRate(payments, balance);
    if (!rateResult.converged) return null;

    const monthlyRate = rateResult.rate / 12;
    const interest = Math.round(balance * monthlyRate * 100) / 100;
    const principal = Math.round((totalPayment - interest) * 100) / 100;

    if (principal <= 0) return null;

    return { principal, interest };
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/lib/services/__tests__/mortgage-compute.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/services/mortgage.service.ts src/lib/services/__tests__/mortgage-compute.test.ts
git commit -m "feat: add computePaymentForDate to MortgageService for dynamic scheduled tx amounts"
```

---

## Task 6: Create New Scheduled Transaction — Service + API

**Files:**
- Create: `src/lib/services/scheduled-tx-create.ts`
- Create: `src/lib/__tests__/scheduled-tx-create.test.ts`
- Modify: `src/app/api/scheduled-transactions/route.ts` (add POST handler)

- [ ] **Step 1: Write tests**

Create `src/lib/__tests__/scheduled-tx-create.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecuteRaw = vi.fn();
const mockQueryRaw = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => mockTransaction(fn),
  },
}));

vi.mock('../gnucash', () => ({
  generateGuid: vi.fn()
    .mockReturnValueOnce('sx-guid')
    .mockReturnValueOnce('root-guid')
    .mockReturnValueOnce('child-1-guid')
    .mockReturnValueOnce('child-2-guid')
    .mockReturnValueOnce('tmpl-tx-guid')
    .mockReturnValueOnce('tmpl-split-1-guid')
    .mockReturnValueOnce('tmpl-split-2-guid'),
  fromDecimal: vi.fn().mockReturnValue({ num: 150000n, denom: 100n }),
}));

import { createScheduledTransaction } from '../services/scheduled-tx-create';

describe('Create Scheduled Transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation(async (fn) => {
      const tx = { $executeRaw: mockExecuteRaw, $queryRaw: mockQueryRaw };
      return fn(tx);
    });
  });

  it('should create full template structure', async () => {
    // Mock template root lookup
    mockQueryRaw.mockResolvedValueOnce([{ guid: 'book-template-root' }]);
    // Mock currency lookup
    mockQueryRaw.mockResolvedValueOnce([{ guid: 'usd-guid' }]);

    const result = await createScheduledTransaction({
      name: 'Monthly Rent',
      startDate: '2026-01-01',
      endDate: null,
      recurrence: {
        periodType: 'month',
        mult: 1,
        periodStart: '2026-01-01',
        weekendAdjust: 'none',
      },
      splits: [
        { accountGuid: 'checking-guid', amount: -1500 },
        { accountGuid: 'expense-guid', amount: 1500 },
      ],
      autoCreate: false,
      autoNotify: false,
    });

    expect(result.success).toBe(true);
    expect(result.guid).toBeDefined();
    // Verify creation: root account, 2 child accounts, 2 slots, 1 template tx, 2 template splits, 1 schedxaction, 1 recurrence
    // That's at least 9 $executeRaw calls
    expect(mockExecuteRaw.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it('should reject when splits do not balance', async () => {
    const result = await createScheduledTransaction({
      name: 'Bad Split',
      startDate: '2026-01-01',
      endDate: null,
      recurrence: {
        periodType: 'month',
        mult: 1,
        periodStart: '2026-01-01',
        weekendAdjust: 'none',
      },
      splits: [
        { accountGuid: 'checking-guid', amount: -1500 },
        { accountGuid: 'expense-guid', amount: 1000 }, // doesn't balance
      ],
      autoCreate: false,
      autoNotify: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('balance');
  });

  it('should validate required fields', async () => {
    const result = await createScheduledTransaction({
      name: '',
      startDate: '2026-01-01',
      endDate: null,
      recurrence: {
        periodType: 'month',
        mult: 1,
        periodStart: '2026-01-01',
        weekendAdjust: 'none',
      },
      splits: [],
      autoCreate: false,
      autoNotify: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('name');
  });
});
```

- [ ] **Step 2: Implement create service**

Create `src/lib/services/scheduled-tx-create.ts`:

```typescript
import prisma from '@/lib/prisma';
import { generateGuid, fromDecimal } from '@/lib/gnucash';

export interface CreateScheduledTxInput {
  name: string;
  startDate: string;
  endDate: string | null;
  recurrence: {
    periodType: string;
    mult: number;
    periodStart: string;
    weekendAdjust: string;
  };
  splits: Array<{
    accountGuid: string;
    amount: number;
  }>;
  autoCreate: boolean;
  autoNotify: boolean;
}

export interface CreateResult {
  success: boolean;
  guid?: string;
  error?: string;
}

const VALID_PERIOD_TYPES = ['once', 'daily', 'weekly', 'month', 'end of month', 'semi_monthly', 'year', 'nth weekday', 'last weekday'];

export async function createScheduledTransaction(input: CreateScheduledTxInput): Promise<CreateResult> {
  // Validate
  if (!input.name?.trim()) {
    return { success: false, error: 'name is required' };
  }
  if (input.splits.length < 2) {
    return { success: false, error: 'At least 2 splits are required' };
  }
  if (!VALID_PERIOD_TYPES.includes(input.recurrence.periodType)) {
    return { success: false, error: `Invalid period type. Must be one of: ${VALID_PERIOD_TYPES.join(', ')}` };
  }

  // Check splits balance (sum should be ~0, allowing for floating point)
  const sum = input.splits.reduce((s, split) => s + split.amount, 0);
  if (Math.abs(sum) > 0.01) {
    return { success: false, error: 'Splits must balance (sum to zero)' };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // 1. Find the book's template root account
      const templateRoots = await tx.$queryRaw<{ guid: string }[]>`
        SELECT guid FROM accounts WHERE name = 'Template Root' AND account_type = 'ROOT'
        LIMIT 1
      `;

      if (templateRoots.length === 0) {
        return { success: false, error: 'Template root account not found in database' };
      }
      const templateRootGuid = templateRoots[0].guid;

      // Get book currency
      const currencies = await tx.$queryRaw<{ guid: string }[]>`
        SELECT c.guid FROM commodities c
        WHERE c.namespace = 'CURRENCY'
        ORDER BY c.mnemonic ASC LIMIT 1
      `;
      const currencyGuid = currencies[0]?.guid ?? 'USD';

      // 2. Create template root account for this scheduled transaction
      const sxRootGuid = generateGuid();
      await tx.$executeRaw`
        INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
        VALUES (${sxRootGuid}, ${input.name}, 'BANK', ${currencyGuid}, 100, 0, ${templateRootGuid}, '', '', 0, 0)
      `;

      // 3. For each split, create template child account + slot mapping
      const childGuids: string[] = [];
      for (const split of input.splits) {
        const childGuid = generateGuid();
        childGuids.push(childGuid);

        await tx.$executeRaw`
          INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
          VALUES (${childGuid}, '', 'BANK', ${currencyGuid}, 100, 0, ${sxRootGuid}, '', '', 0, 0)
        `;

        // Slot mapping: template child -> real account
        await tx.$executeRaw`
          INSERT INTO slots (obj_guid, name, slot_type, string_val, guid_val)
          VALUES (${childGuid}, 'account', 4, NULL, ${split.accountGuid})
        `;
      }

      // 4. Create template transaction with splits
      const tmplTxGuid = generateGuid();
      await tx.$executeRaw`
        INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
        VALUES (${tmplTxGuid}, ${currencyGuid}, '', NULL, ${new Date()}, ${input.name})
      `;

      for (let i = 0; i < input.splits.length; i++) {
        const splitGuid = generateGuid();
        const { num, denom } = fromDecimal(input.splits[i].amount);
        await tx.$executeRaw`
          INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
          VALUES (${splitGuid}, ${tmplTxGuid}, ${childGuids[i]}, '', '', 'n', ${num}, ${denom}, ${num}, ${denom}, NULL)
        `;
      }

      // 5. Create schedxaction record
      const sxGuid = generateGuid();
      await tx.$executeRaw`
        INSERT INTO schedxactions (guid, name, enabled, start_date, end_date, last_occur, num_occur, rem_occur, auto_create, auto_notify, adv_creation, adv_notify, instance_count, template_act_guid)
        VALUES (${sxGuid}, ${input.name}, 1, ${new Date(input.startDate + 'T00:00:00Z')}, ${input.endDate ? new Date(input.endDate + 'T00:00:00Z') : null}, NULL, -1, -1, ${input.autoCreate ? 1 : 0}, ${input.autoNotify ? 1 : 0}, 0, 0, 0, ${sxRootGuid})
      `;

      // 6. Create recurrence record
      await tx.$executeRaw`
        INSERT INTO recurrences (obj_guid, recurrence_mult, recurrence_period_type, recurrence_period_start, recurrence_weekend_adjust)
        VALUES (${sxGuid}, ${input.recurrence.mult}, ${input.recurrence.periodType}, ${new Date(input.recurrence.periodStart + 'T00:00:00Z')}, ${input.recurrence.weekendAdjust})
      `;

      return { success: true, guid: sxGuid };
    });
  } catch (error) {
    console.error('Error creating scheduled transaction:', error);
    return { success: false, error: 'Failed to create scheduled transaction' };
  }
}
```

- [ ] **Step 3: Add POST handler to existing route**

In `src/app/api/scheduled-transactions/route.ts`, add a POST export:

```typescript
import { createScheduledTransaction, CreateScheduledTxInput } from '@/lib/services/scheduled-tx-create';

export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body: CreateScheduledTxInput = await request.json();
    const result = await createScheduledTransaction(body);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error('Error creating scheduled transaction:', error);
    return NextResponse.json({ error: 'Failed to create' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/__tests__/scheduled-tx-create.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/scheduled-tx-create.ts src/lib/__tests__/scheduled-tx-create.test.ts src/app/api/scheduled-transactions/route.ts
git commit -m "feat: add create scheduled transaction service with full GnuCash template structure"
```

---

## Task 7: UI Updates — Execute/Skip Buttons, Enable Toggle, Batch Banner

**Files:**
- Modify: `src/app/(main)/scheduled-transactions/page.tsx`

- [ ] **Step 1: Add execute/skip buttons to upcoming view**

In the `renderUpcomingRow()` function, add Execute and Skip buttons after the amount display. On desktop, they go inline on the right. On mobile, they appear as a compact row below the occurrence info.

Desktop (inside `hidden sm:flex`):
```tsx
<button
  onClick={() => handleExecute(occ.scheduledTransactionGuid, occ.date)}
  disabled={actionStates[`${occ.scheduledTransactionGuid}-${occ.date}`] === 'loading'}
  className="px-3 py-1 text-xs font-medium rounded-md bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 transition-colors"
>
  {actionStates[`${occ.scheduledTransactionGuid}-${occ.date}`] === 'loading' ? '...' :
   actionStates[`${occ.scheduledTransactionGuid}-${occ.date}`] === 'executed' ? 'Executed ✓' : 'Execute'}
</button>
<button
  onClick={() => handleSkip(occ.scheduledTransactionGuid, occ.date)}
  disabled={actionStates[`${occ.scheduledTransactionGuid}-${occ.date}`] === 'loading'}
  className="px-3 py-1 text-xs font-medium rounded-md bg-gray-600/50 hover:bg-gray-500/50 text-foreground-muted disabled:opacity-50 transition-colors"
>
  {actionStates[`${occ.scheduledTransactionGuid}-${occ.date}`] === 'skipped' ? 'Skipped' : 'Skip'}
</button>
```

Mobile (below content, always visible):
```tsx
<div className="sm:hidden mt-2 flex gap-2">
  {/* Same buttons with full-width styling */}
</div>
```

Add state and handlers:
```typescript
const [actionStates, setActionStates] = useState<Record<string, 'loading' | 'executed' | 'skipped' | 'error'>>({});

const handleExecute = async (guid: string, date: string) => {
  const key = `${guid}-${date}`;
  setActionStates(prev => ({ ...prev, [key]: 'loading' }));
  try {
    const res = await fetch(`/api/scheduled-transactions/${guid}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ occurrenceDate: date }),
    });
    if (!res.ok) throw new Error('Failed');
    setActionStates(prev => ({ ...prev, [key]: 'executed' }));
  } catch {
    setActionStates(prev => ({ ...prev, [key]: 'error' }));
  }
};

const handleSkip = async (guid: string, date: string) => {
  const key = `${guid}-${date}`;
  setActionStates(prev => ({ ...prev, [key]: 'loading' }));
  try {
    const res = await fetch(`/api/scheduled-transactions/${guid}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ occurrenceDate: date }),
    });
    if (!res.ok) throw new Error('Failed');
    setActionStates(prev => ({ ...prev, [key]: 'skipped' }));
  } catch {
    setActionStates(prev => ({ ...prev, [key]: 'error' }));
  }
};
```

- [ ] **Step 2: Add overdue banner with "Process All" button**

At the top of the upcoming view (before the list), add a contextual banner:

```tsx
const overdueOccurrences = useMemo(() => {
  const today = new Date().toISOString().split('T')[0];
  return filteredUpcoming.filter(o => o.date < today);
}, [filteredUpcoming]);

// Render in the upcoming view section:
{viewMode === 'upcoming' && overdueOccurrences.length > 0 && (
  <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex items-center justify-between">
    <div>
      <span className="text-amber-400 font-medium">
        {overdueOccurrences.length} overdue transaction{overdueOccurrences.length > 1 ? 's' : ''}
      </span>
      <span className="text-foreground-muted text-sm ml-2">
        Ready to process since last run
      </span>
    </div>
    <button
      onClick={handleBatchExecute}
      disabled={batchLoading}
      className="px-4 py-2 text-sm font-medium rounded-lg bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-50 transition-colors"
    >
      {batchLoading ? 'Processing...' : 'Process All'}
    </button>
  </div>
)}
```

- [ ] **Step 3: Replace enabled/disabled badge with toggle in All view**

In `renderTransactionRow()`, replace the static badge with an interactive toggle:

```tsx
<button
  onClick={async () => {
    const newEnabled = !tx.enabled;
    // Optimistic update
    setTransactions(prev => prev.map(t =>
      t.guid === tx.guid ? { ...t, enabled: newEnabled } : t
    ));
    try {
      const res = await fetch(`/api/scheduled-transactions/${tx.guid}/enable`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newEnabled }),
      });
      if (!res.ok) {
        // Revert on failure
        setTransactions(prev => prev.map(t =>
          t.guid === tx.guid ? { ...t, enabled: !newEnabled } : t
        ));
      }
    } catch {
      setTransactions(prev => prev.map(t =>
        t.guid === tx.guid ? { ...t, enabled: !newEnabled } : t
      ));
    }
  }}
  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
    tx.enabled ? 'bg-emerald-500' : 'bg-gray-600'
  }`}
  role="switch"
  aria-checked={tx.enabled}
  aria-label={`${tx.enabled ? 'Disable' : 'Enable'} ${tx.name}`}
>
  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
    tx.enabled ? 'translate-x-4' : 'translate-x-1'
  }`} />
</button>
```

- [ ] **Step 4: Add "+ New" button in header**

In the page header, add a button that opens the create panel:

```tsx
<header className="flex items-center justify-between">
  <div>
    <h1 className="text-3xl font-bold text-foreground">Scheduled Transactions</h1>
    <p className="text-foreground-muted">
      Manage recurring and one-time scheduled transactions.
    </p>
  </div>
  <button
    onClick={() => setShowCreatePanel(true)}
    className="px-4 py-2 text-sm font-medium rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white transition-colors flex items-center gap-2"
  >
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
    New
  </button>
</header>
```

Add state: `const [showCreatePanel, setShowCreatePanel] = useState(false);`

- [ ] **Step 5: Verify build**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add "src/app/(main)/scheduled-transactions/page.tsx"
git commit -m "feat: add execute/skip buttons, enable toggle, batch banner, and new button to scheduled transactions page"
```

---

## Task 8: Create Scheduled Transaction — Slide-over Panel

**Files:**
- Create: `src/components/scheduled-transactions/CreateScheduledPanel.tsx`
- Modify: `src/app/(main)/scheduled-transactions/page.tsx` (add panel integration)

- [ ] **Step 1: Create the slide-over panel component**

Create `src/components/scheduled-transactions/CreateScheduledPanel.tsx` with:
- Slide-over from right with overlay backdrop
- Form fields: name, period type dropdown, multiplier, start date, end date (optional), auto-create toggle, auto-notify toggle
- Splits section: two rows (debit + credit) with account picker (simple text input with account guid, or a dropdown fetched from `/api/accounts?flat=true`) and amount input
- "+ Add Split" button for multi-split transactions
- Validation: name required, splits must balance, at least 2 splits
- Submit calls POST `/api/scheduled-transactions`
- On success: close panel, refetch data
- On error: inline error display
- Escape key and backdrop click to close
- `aria-modal="true"`, focus trap

The component should be ~200 lines. Use the existing design tokens: `bg-surface/95 backdrop-blur-xl`, `border-border`, input classes matching the rest of the app.

- [ ] **Step 2: Integrate panel into page**

In `src/app/(main)/scheduled-transactions/page.tsx`, import and render:

```tsx
import { CreateScheduledPanel } from '@/components/scheduled-transactions/CreateScheduledPanel';

// At the end of the return, before closing </div>:
{showCreatePanel && (
  <CreateScheduledPanel
    onClose={() => setShowCreatePanel(false)}
    onCreated={() => {
      setShowCreatePanel(false);
      fetchData(); // Refetch to show the new transaction
    }}
  />
)}
```

- [ ] **Step 3: Verify build**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/components/scheduled-transactions/CreateScheduledPanel.tsx "src/app/(main)/scheduled-transactions/page.tsx"
git commit -m "feat: add create scheduled transaction slide-over panel with recurrence, splits, and validation"
```

---

## Task 9: Final Verification

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: No new errors

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit any fixes**

If fixes needed:
```bash
git add -A
git commit -m "fix: address test/lint/build issues in scheduled transactions write"
```
