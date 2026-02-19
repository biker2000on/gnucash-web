# SimpleFin Investment Account Routing - Refined Implementation Plan (v3)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route SimpleFin brokerage transactions to child stock accounts under a mapped parent investment account, with auto-creation of child accounts and a cash fallback.

**Architecture:** When a SimpleFin account has holdings (or user toggles investment mode), the sync engine parses ticker symbols from transaction descriptions, validates them against the holdings symbol set, and routes each transaction to the matching child STOCK account under the mapped GnuCash parent. Unmatched transactions go to a `Cash` child. Missing child accounts and commodities are auto-created. A new `importInvestmentTransaction` function handles the investment-specific split logic: the primary split goes to the target child account, and the counter-split goes to the Cash child (for symbol-matched transactions) or uses `guessCategory` (for unmatched Cash transactions).

**Tech Stack:** Next.js 16, TypeScript, Prisma raw SQL, PostgreSQL, React 19

**Design Doc:** `docs/plans/2026-02-19-simplefin-investments-design.md`

---

## Known Limitations (Phase 1)

### 1. Dollar-Amount-as-Quantity for STOCK Accounts

**Problem:** GnuCash STOCK account splits should store `value` in the transaction currency (USD) and `quantity` in shares. However, SimpleFin only provides dollar amounts per transaction -- it does NOT provide per-transaction share quantities.

**Phase 1 Approach:** Store the dollar amount for BOTH `value_num` AND `quantity_num` on ALL splits, including STOCK child account splits. This means `value == quantity` for every split, which is technically incorrect for STOCK accounts but is the only option without share data.

**Why This Is Acceptable:**
- The primary user goal is achieved: transactions are organized by security symbol under the correct child accounts
- The account hierarchy and transaction history are correct
- Balance displays will show dollar amounts rather than share counts, which is arguably more useful for the SimpleFin use case
- GnuCash desktop also creates dollar-valued entries when importing from OFX/QFX without share data

**Phase 2 Fix:** `// TODO Phase 2: compute share quantities from holdings price data`. SimpleFin provides `shares` and `market_value` per holding which could be used to retroactively calculate price-per-share at each point in time, or the yahoo-finance2 price backfill data could provide daily closing prices to derive share quantities.

### 2. `trading-accounts.ts` Not Used

**Why:** The codebase has `src/lib/trading-accounts.ts` with `processMultiCurrencySplits()` and `getOrCreateTradingAccount()`. These are designed for multi-CURRENCY transactions (e.g., USD to EUR transfers) where trading accounts balance the equation across currencies. They are NOT used here because:
- GnuCash desktop's default behavior for stock purchases does NOT create trading account entries
- Trading accounts are an optional GnuCash preference ("Use Trading Accounts"), not default
- Since Phase 1 stores `value == quantity` in dollar terms, there's no quantity imbalance that trading accounts would need to resolve
- Using trading accounts would add unnecessary complexity for zero benefit in Phase 1

### 3. Commodity Namespace

New commodities are created with `namespace: 'UNKNOWN'` since we don't know the exchange. Users can update this via GnuCash desktop. Phase 2 could use yahoo-finance2 to detect the correct exchange.

---

## Corrections from Original Plan

The following issues were found by reading every referenced file and verifying against the actual codebase:

1. **`bookGuid` parameter unused in `getOrCreateChildAccount`**: The original plan passes `bookGuid` to this function but never uses it. Removed from the refined version.

2. **Holdings data lost during chunked fetching**: The sync engine uses `fetchAccountsChunked()` which merges accounts across chunks but only preserves `transactions`, `balance`, and `available-balance` -- NOT `holdings`. Need to also merge holdings during chunking, OR fetch holdings separately. We fix this in the chunked fetching merge logic.

3. **Auto-detect investment logic**: Uses `a.isInvestment || (a.hasHoldings && !a.isMapped)` to auto-enable for NEW unmapped accounts with holdings, but respect the DB value once a mapping exists. See detailed explanation in Task 7.

4. **`account_hierarchy` view is auto-updating**: Since `account_hierarchy` is a regular VIEW (not a MATERIALIZED VIEW), newly created child accounts are automatically visible in queries. No refresh call needed after creating child accounts.

5. **Commodity `fullname` is nullable**: The Prisma schema has `fullname String? @db.VarChar(2048)`. The original plan uses `fullname: holdingDescription || symbol.toUpperCase()` which is correct since it always provides a non-null value.

6. **DDL execution location**: The `simpleFinAccountMapTableDDL` is executed at line 386 of `db-init.ts`. The new ALTER TABLE DDL should be added immediately after this line.

7. **The `commodity_scu` for STOCK accounts**: Should match the commodity's `fraction` field. The plan creates commodities with `fraction: 10000` (4 decimal places for stock prices) and accounts with `commodity_scu: commodity.fraction`, which is correct.

8. **No `simpleFinLast4` in mapping**: The `handleSfMapAccount` and `handleSfToggleInvestment` functions don't send `simpleFinLast4` in the request body, but the SQL `ON CONFLICT ... DO UPDATE` uses `COALESCE` which preserves the existing value -- so this is fine.

9. **VALUE/QUANTITY for STOCK splits (CRITICAL)**: The original `importTransaction` forces `value_num == quantity_num` on all splits. For STOCK accounts, GnuCash requires value in dollars and quantity in shares. Since SimpleFin lacks per-transaction share data, Phase 1 explicitly stores dollar amounts for both, with prominent code comments documenting this limitation. A separate `importInvestmentTransaction` function is created to handle investment-specific routing.

10. **Counter-account logic for investments**: Symbol-matched STOCK transactions use the Cash child as the counter-account (representing the brokerage sweep/cash balance), NOT `guessCategory`. Only unmatched Cash child transactions use `guessCategory`.

---

### Task 1: Add `is_investment` Column to Account Map Table

**Files:**
- Modify: `src/lib/db-init.ts`

**Step 1: Add the column migration DDL**

In `src/lib/db-init.ts`, find the `simpleFinAccountMapTableDDL` variable (starts at line 356). After it (after line 369), add:

```typescript
const simpleFinAccountMapAddInvestmentDDL = `
    ALTER TABLE gnucash_web_simplefin_account_map
    ADD COLUMN IF NOT EXISTS is_investment BOOLEAN NOT NULL DEFAULT FALSE;
`;
```

**Step 2: Execute the new DDL**

Find where `simpleFinAccountMapTableDDL` is executed (line 386):
```typescript
await query(simpleFinAccountMapTableDDL);
```

Add immediately after it (at line 387):
```typescript
await query(simpleFinAccountMapAddInvestmentDDL);
```

**Step 3: Verify the migration runs**

Run: `npm run dev` and check the console for `Extension tables created/verified successfully` with no errors.

**Step 4: Commit**

```bash
git add src/lib/db-init.ts
git commit -m "feat: add is_investment column to simplefin account map table"
```

**Acceptance criteria:**
- Dev server starts without DB errors
- Running `SELECT column_name FROM information_schema.columns WHERE table_name = 'gnucash_web_simplefin_account_map' AND column_name = 'is_investment'` returns one row

---

### Task 2: Add `holdings` to SimpleFin API Types and Fix Chunked Merge

**Files:**
- Modify: `src/lib/services/simplefin.service.ts`

**Step 1: Add `SimpleFinHolding` interface**

In `src/lib/services/simplefin.service.ts`, add a new interface BEFORE the existing `SimpleFinAccount` interface (before line 75). Insert after line 73 (end of `SimpleFinTransaction`):

```typescript
export interface SimpleFinHolding {
  id?: string;
  created?: number;
  currency?: string;
  cost_basis?: string;
  description?: string;
  market_value?: string;
  purchase_price?: string;
  shares?: string;
  symbol?: string;
}
```

**Step 2: Add `holdings` to `SimpleFinAccount`**

Update the `SimpleFinAccount` interface (line 75-88) to add `holdings`:

```typescript
export interface SimpleFinAccount {
  id: string;
  name: string;
  currency: string;
  balance: string;
  'available-balance'?: string;
  org?: {
    name?: string;
    domain?: string;
    url?: string;
    'sfin-url'?: string;
  };
  transactions?: SimpleFinTransaction[];
  holdings?: SimpleFinHolding[];
}
```

**Step 3: Fix `fetchAccountsChunked` to preserve holdings**

In the `fetchAccountsChunked` function (line 171-215), the merge loop at line 196-208 only preserves transactions, balance, and available-balance. Update the merge block to also preserve holdings. Find:

```typescript
      if (existing) {
        // Merge transactions
        const existingTxIds = new Set(existing.transactions?.map(t => t.id) || []);
        const newTxns = account.transactions?.filter(t => !existingTxIds.has(t.id)) || [];
        existing.transactions = [...(existing.transactions || []), ...newTxns];
        // Update balance to latest
        existing.balance = account.balance;
        existing['available-balance'] = account['available-balance'];
      }
```

Replace with:

```typescript
      if (existing) {
        // Merge transactions
        const existingTxIds = new Set(existing.transactions?.map(t => t.id) || []);
        const newTxns = account.transactions?.filter(t => !existingTxIds.has(t.id)) || [];
        existing.transactions = [...(existing.transactions || []), ...newTxns];
        // Update balance to latest
        existing.balance = account.balance;
        existing['available-balance'] = account['available-balance'];
        // Preserve holdings (take latest non-empty)
        if (account.holdings && account.holdings.length > 0) {
          existing.holdings = account.holdings;
        }
      }
```

**Step 4: Commit**

```bash
git add src/lib/services/simplefin.service.ts
git commit -m "feat: add holdings interface to SimpleFin API types and preserve in chunked fetch"
```

**Acceptance criteria:**
- `npx tsc --noEmit` passes
- `SimpleFinHolding` is exported
- `SimpleFinAccount.holdings` is typed as `SimpleFinHolding[]`

---

### Task 3: Create Symbol Parser Service

**Files:**
- Create: `src/lib/services/simplefin-symbol-parser.ts`

**Step 1: Create the file**

Create `src/lib/services/simplefin-symbol-parser.ts`:

```typescript
/**
 * SimpleFin Symbol Parser
 *
 * Extracts stock ticker symbols from SimpleFin transaction descriptions
 * by matching against a known set of holdings symbols.
 */

import type { SimpleFinHolding } from './simplefin.service';

export interface SymbolMatch {
  symbol: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Build a lookup map from holdings: symbol -> holding description.
 */
export function buildSymbolSet(holdings: SimpleFinHolding[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of holdings) {
    if (h.symbol) {
      map.set(h.symbol.toUpperCase(), h.description || h.symbol);
    }
  }
  return map;
}

/**
 * Parse a transaction description to extract a ticker symbol.
 * Validates candidates against the known holdings symbol set.
 *
 * Strategy (in priority order):
 * 1. Parenthesized ticker: "BOUGHT ... (VOO) ..."
 * 2. Bracketed ticker: "DIVIDEND [AAPL]"
 * 3. Known symbol as standalone word in text: "SOLD MSFT 10 SHARES"
 * 4. Holdings description substring match: "VANGUARD S&P 500 ETF" -> VOO
 */
export function parseSymbol(
  description: string,
  symbolSet: Map<string, string>
): SymbolMatch | null {
  if (!description || symbolSet.size === 0) return null;

  const upper = description.toUpperCase();

  // 1. Parenthesized ticker: (VOO), (AAPL)
  const parenMatches = upper.matchAll(/\(([A-Z]{1,5})\)/g);
  for (const m of parenMatches) {
    if (symbolSet.has(m[1])) {
      return { symbol: m[1], confidence: 'high' };
    }
  }

  // 2. Bracketed ticker: [AAPL], [VOO]
  const bracketMatches = upper.matchAll(/\[([A-Z]{1,5})\]/g);
  for (const m of bracketMatches) {
    if (symbolSet.has(m[1])) {
      return { symbol: m[1], confidence: 'high' };
    }
  }

  // 3. Standalone word matching a known symbol
  const words = upper.match(/\b([A-Z]{1,5})\b/g) || [];
  const NOISE = new Set([
    'USD', 'ETF', 'THE', 'AND', 'FOR', 'YOU', 'BUY', 'SELL',
    'CASH', 'FUND', 'SOLD', 'AUTO', 'FEE', 'TAX', 'DIV',
    'INC', 'LTD', 'LLC', 'CORP', 'CO', 'INT', 'NEW', 'NET',
  ]);
  for (const word of words) {
    if (!NOISE.has(word) && symbolSet.has(word)) {
      return { symbol: word, confidence: 'medium' };
    }
  }

  // 4. Holdings description substring match
  for (const [symbol, holdingDesc] of symbolSet) {
    if (holdingDesc && upper.includes(holdingDesc.toUpperCase())) {
      return { symbol, confidence: 'low' };
    }
  }

  return null;
}
```

**Step 2: Commit**

```bash
git add src/lib/services/simplefin-symbol-parser.ts
git commit -m "feat: add symbol parser for SimpleFin investment transactions"
```

**Acceptance criteria:**
- `npx tsc --noEmit` passes
- Exports: `SymbolMatch`, `buildSymbolSet`, `parseSymbol`

---

### Task 4: Add Investment Mode to Sync Engine

**Files:**
- Modify: `src/lib/services/simplefin-sync.service.ts`

This is the largest task. The sync engine needs:
- A new `importInvestmentTransaction` function separate from `importTransaction`
- Investment-mode branching in the sync loop
- Child account creation helpers
- Correct counter-account logic: STOCK child txns counter to Cash child; Cash child txns counter via `guessCategory`

**CRITICAL DESIGN DECISIONS:**
1. **value == quantity for ALL splits** (including STOCK children). SimpleFin lacks share data. See "Known Limitations" section above.
2. **Counter-account for symbol-matched transactions** = Cash child (the brokerage sweep account), NOT `guessCategory`
3. **Counter-account for unmatched transactions** = `guessCategory` (same as normal mode)
4. **Do NOT use `processMultiCurrencySplits()` from `src/lib/trading-accounts.ts`**. See "Known Limitations" section above.

**Step 1: Add imports**

At the top of `src/lib/services/simplefin-sync.service.ts`, update the imports. The current imports (lines 8-10) are:

```typescript
import prisma, { generateGuid } from '@/lib/prisma';
import { decryptAccessUrl, fetchAccountsChunked, SimpleFinTransaction, SimpleFinAccessRevokedError } from './simplefin.service';
import { toNumDenom } from '@/lib/validation';
```

Replace with:

```typescript
import prisma, { generateGuid } from '@/lib/prisma';
import { decryptAccessUrl, fetchAccountsChunked, SimpleFinTransaction, SimpleFinAccessRevokedError, SimpleFinHolding } from './simplefin.service';
import { toNumDenom } from '@/lib/validation';
import { buildSymbolSet, parseSymbol } from './simplefin-symbol-parser';
```

**Step 2: Update `SyncResult` to track investment transactions**

Find the `SyncResult` interface (lines 12-17):

```typescript
export interface SyncResult {
  accountsProcessed: number;
  transactionsImported: number;
  transactionsSkipped: number;
  errors: { account: string; error: string }[];
}
```

Replace with:

```typescript
export interface SyncResult {
  accountsProcessed: number;
  transactionsImported: number;
  transactionsSkipped: number;
  investmentTransactionsImported: number;
  errors: { account: string; error: string }[];
}
```

And update the initial `result` object in `syncSimpleFin` (around line 23-28) to include `investmentTransactionsImported: 0`:

```typescript
  const result: SyncResult = {
    accountsProcessed: 0,
    transactionsImported: 0,
    transactionsSkipped: 0,
    investmentTransactionsImported: 0,
    errors: [],
  };
```

Also update `syncAllConnections` (the catch block around line 412) to include `investmentTransactionsImported: 0` in the error result.

**Step 3: Add helper functions for child account creation**

After the `getOrCreateImbalanceAccount` function (ends at line 391, before `syncAllConnections` at line 396), add:

```typescript
/**
 * Find or create a child account under the parent for a given stock symbol.
 * Creates the commodity if it doesn't exist, then creates a STOCK child account.
 */
async function getOrCreateChildAccount(
  parentGuid: string,
  symbol: string,
  holdingDescription: string,
): Promise<string> {
  // Look for existing child with a commodity matching this symbol
  const existingChildren = await prisma.$queryRaw<{
    guid: string;
    commodity_guid: string;
  }[]>`
    SELECT a.guid, a.commodity_guid
    FROM accounts a
    JOIN commodities c ON c.guid = a.commodity_guid
    WHERE a.parent_guid = ${parentGuid}
      AND UPPER(c.mnemonic) = ${symbol.toUpperCase()}
  `;

  if (existingChildren.length > 0) {
    return existingChildren[0].guid;
  }

  // Look up or create the commodity
  let commodity = await prisma.commodities.findFirst({
    where: { mnemonic: symbol.toUpperCase() },
  });

  if (!commodity) {
    const commodityGuid = generateGuid();
    await prisma.commodities.create({
      data: {
        guid: commodityGuid,
        namespace: 'UNKNOWN',
        mnemonic: symbol.toUpperCase(),
        fullname: holdingDescription || symbol.toUpperCase(),
        cusip: '',
        fraction: 10000,
        quote_flag: 1,
        quote_source: 'yahoo_json',
        quote_tz: '',
      },
    });
    commodity = await prisma.commodities.findUnique({ where: { guid: commodityGuid } });
  }

  if (!commodity) throw new Error(`Failed to create commodity for ${symbol}`);

  // Create the STOCK child account
  const childGuid = generateGuid();
  await prisma.accounts.create({
    data: {
      guid: childGuid,
      name: symbol.toUpperCase(),
      account_type: 'STOCK',
      commodity_guid: commodity.guid,
      commodity_scu: commodity.fraction,
      non_std_scu: 0,
      parent_guid: parentGuid,
      code: '',
      description: holdingDescription || `Auto-created for ${symbol}`,
      hidden: 0,
      placeholder: 0,
    },
  });

  return childGuid;
}

/**
 * Find or create a Cash child account under the parent.
 * Uses the parent's commodity (USD) and account type.
 */
async function getOrCreateCashChild(
  parentGuid: string,
): Promise<string> {
  const existing = await prisma.accounts.findFirst({
    where: { parent_guid: parentGuid, name: 'Cash' },
  });
  if (existing) return existing.guid;

  const parent = await prisma.accounts.findUnique({
    where: { guid: parentGuid },
  });
  if (!parent) throw new Error(`Parent account ${parentGuid} not found`);

  const childGuid = generateGuid();
  await prisma.accounts.create({
    data: {
      guid: childGuid,
      name: 'Cash',
      account_type: parent.account_type,
      commodity_guid: parent.commodity_guid!,
      commodity_scu: parent.commodity_scu,
      non_std_scu: 0,
      parent_guid: parentGuid,
      code: '',
      description: 'Cash balance (auto-created for SimpleFin)',
      hidden: 0,
      placeholder: 0,
    },
  });

  return childGuid;
}
```

**Step 4: Add `importInvestmentTransaction` function**

After the `getOrCreateCashChild` function (added in Step 3), add:

```typescript
/**
 * Import a single SimpleFin transaction into GnuCash for an INVESTMENT account.
 *
 * This differs from `importTransaction` in two key ways:
 * 1. The counter-account for symbol-matched transactions is the Cash child
 *    (representing the brokerage sweep/cash account), NOT guessCategory.
 * 2. For unmatched transactions routed to Cash child, guessCategory IS used
 *    as the counter-account (same as normal import behavior).
 *
 * NOTE: Phase 1 limitation - quantity is stored in dollar terms, not shares.
 * SimpleFin does not provide per-transaction share quantities. Both value_num
 * and quantity_num are set to the dollar amount for ALL splits, including
 * STOCK child account splits. This is technically incorrect for STOCK accounts
 * where quantity should represent shares, but it still achieves the primary
 * goal of organizing transactions by security symbol.
 *
 * // TODO Phase 2: compute share quantities from holdings price data.
 * // SimpleFin provides shares and market_value per holding. Combined with
 * // daily price data from yahoo-finance2 price backfill, share quantities
 * // could be derived: shares = dollar_amount / price_per_share_on_date.
 *
 * NOTE: We intentionally do NOT use processMultiCurrencySplits() from
 * src/lib/trading-accounts.ts here. That utility is for multi-CURRENCY
 * transactions (e.g., USD to EUR). GnuCash desktop's default behavior
 * for stock purchases does not create trading account entries. Since
 * Phase 1 stores value == quantity in dollar terms, there is no quantity
 * imbalance that trading accounts would need to resolve.
 *
 * @param sfTxn - The SimpleFin transaction
 * @param targetAccountGuid - The child account (STOCK or Cash) to route to
 * @param cashChildGuid - The Cash child account guid (used as counter-account for STOCK transactions)
 * @param isSymbolMatched - Whether this transaction was matched to a symbol (routes to STOCK child)
 * @param currencyGuid - The transaction currency guid (USD)
 * @param currencyMnemonic - The transaction currency mnemonic ('USD')
 * @param bookGuid - The GnuCash book guid
 * @param bankAccountGuid - The parent investment account guid (for guessCategory lookups)
 */
async function importInvestmentTransaction(
  sfTxn: SimpleFinTransaction,
  targetAccountGuid: string,
  cashChildGuid: string,
  isSymbolMatched: boolean,
  currencyGuid: string,
  currencyMnemonic: string,
  bookGuid: string,
  bankAccountGuid: string,
): Promise<void> {
  const amount = parseFloat(sfTxn.amount);
  if (isNaN(amount) || amount === 0) return;

  // Determine the counter-account:
  // - Symbol-matched (STOCK child): counter = Cash child (brokerage sweep)
  // - Unmatched (Cash child): counter = guessCategory (same as normal import)
  let counterAccountGuid: string;
  if (isSymbolMatched) {
    counterAccountGuid = cashChildGuid;
  } else {
    counterAccountGuid = await guessCategory(
      bankAccountGuid,
      sfTxn.description || sfTxn.payee || '',
      currencyMnemonic,
      bookGuid
    );
  }

  const postDate = new Date(sfTxn.posted * 1000);
  const description = sfTxn.description || sfTxn.payee || 'SimpleFin Import';
  const memo = sfTxn.pending ? '(Pending) ' + (sfTxn.memo || '') : (sfTxn.memo || '');

  const txGuid = generateGuid();
  const split1Guid = generateGuid();
  const split2Guid = generateGuid();

  // NOTE: Phase 1 limitation - dollar amount used for both value and quantity.
  // For STOCK accounts, quantity should be in shares, but SimpleFin lacks
  // per-transaction share data. Both value and quantity are in dollar terms.
  const { num: absNum, denom } = toNumDenom(Math.abs(amount));
  const targetValueNum = amount > 0 ? absNum : -absNum;
  const counterValueNum = amount > 0 ? -absNum : absNum;

  await prisma.$transaction(async (tx) => {
    // Create transaction
    await tx.transactions.create({
      data: {
        guid: txGuid,
        currency_guid: currencyGuid,
        num: '',
        post_date: postDate,
        enter_date: new Date(),
        description,
      },
    });

    // Target account split (STOCK child or Cash child)
    // NOTE: quantity_num == value_num (dollar terms) - see Phase 1 limitation above
    await tx.splits.create({
      data: {
        guid: split1Guid,
        tx_guid: txGuid,
        account_guid: targetAccountGuid,
        memo: memo,
        action: '',
        reconcile_state: 'n',
        reconcile_date: null,
        value_num: BigInt(targetValueNum),
        value_denom: BigInt(denom),
        quantity_num: BigInt(targetValueNum),   // Phase 1: dollar amount, not shares
        quantity_denom: BigInt(denom),           // Phase 1: dollar denom, not share denom
        lot_guid: null,
      },
    });

    // Counter-account split (Cash child for STOCK txns, guessCategory for Cash txns)
    await tx.splits.create({
      data: {
        guid: split2Guid,
        tx_guid: txGuid,
        account_guid: counterAccountGuid,
        memo: '',
        action: '',
        reconcile_state: 'n',
        reconcile_date: null,
        value_num: BigInt(counterValueNum),
        value_denom: BigInt(denom),
        quantity_num: BigInt(counterValueNum),
        quantity_denom: BigInt(denom),
        lot_guid: null,
      },
    });

    // Insert transaction meta (reviewed=false for imports)
    await prisma.$executeRaw`
      INSERT INTO gnucash_web_transaction_meta
        (transaction_guid, source, reviewed, simplefin_transaction_id, confidence)
      VALUES
        (${txGuid}, 'simplefin', FALSE, ${sfTxn.id}, ${isSymbolMatched ? 'medium' : (counterAccountGuid.includes('Imbalance') ? 'low' : 'medium')})
    `;
  });
}
```

**Step 5: Update the mapped accounts query to include `is_investment`**

In the `syncSimpleFin` function, find the mapped accounts query (lines 56-66):

```typescript
  const mappedAccounts = await prisma.$queryRaw<{
    id: number;
    simplefin_account_id: string;
    simplefin_account_name: string | null;
    gnucash_account_guid: string;
    last_sync_at: Date | null;
  }[]>`
    SELECT id, simplefin_account_id, simplefin_account_name, gnucash_account_guid, last_sync_at
    FROM gnucash_web_simplefin_account_map
    WHERE connection_id = ${connectionId} AND gnucash_account_guid IS NOT NULL
  `;
```

Replace with:

```typescript
  const mappedAccounts = await prisma.$queryRaw<{
    id: number;
    simplefin_account_id: string;
    simplefin_account_name: string | null;
    gnucash_account_guid: string;
    last_sync_at: Date | null;
    is_investment: boolean;
  }[]>`
    SELECT id, simplefin_account_id, simplefin_account_name, gnucash_account_guid, last_sync_at, is_investment
    FROM gnucash_web_simplefin_account_map
    WHERE connection_id = ${connectionId} AND gnucash_account_guid IS NOT NULL
  `;
```

**Step 6: Add investment-mode transaction routing**

In the `syncSimpleFin` function, inside the `for (const mappedAccount of mappedAccounts)` loop, replace the transaction processing section. Find the block at lines 155-178:

```typescript
      for (const sfTxn of sfAccount.transactions) {
        // Dedup by SimpleFin transaction ID
        if (existingIds.has(sfTxn.id)) {
          result.transactionsSkipped++;
          continue;
        }

        try {
          await importTransaction(
            sfTxn,
            mappedAccount.gnucash_account_guid,
            currencyGuid,
            currencyMnemonic,
            bookGuid
          );
          result.transactionsImported++;
          existingIds.add(sfTxn.id); // Prevent re-import within same sync
        } catch (err) {
          result.errors.push({
            account: mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id,
            error: `Failed to import transaction ${sfTxn.id}: ${err}`,
          });
        }
      }
```

Replace with:

```typescript
      // Build holdings symbol set if investment account
      const sfHoldings: SimpleFinHolding[] = sfAccount.holdings || [];
      const symbolSet = mappedAccount.is_investment ? buildSymbolSet(sfHoldings) : new Map<string, string>();

      // Pre-resolve Cash child guid for investment accounts (avoids repeated lookups)
      let cashChildGuid: string | undefined;
      if (mappedAccount.is_investment) {
        cashChildGuid = await getOrCreateCashChild(mappedAccount.gnucash_account_guid);
      }

      for (const sfTxn of sfAccount.transactions) {
        // Dedup by SimpleFin transaction ID
        if (existingIds.has(sfTxn.id)) {
          result.transactionsSkipped++;
          continue;
        }

        try {
          if (mappedAccount.is_investment) {
            // Investment mode: route to child account by symbol
            const match = parseSymbol(sfTxn.description || '', symbolSet);
            let targetAccountGuid: string;
            let isSymbolMatched: boolean;

            if (match) {
              const holdingDesc = symbolSet.get(match.symbol) || match.symbol;
              targetAccountGuid = await getOrCreateChildAccount(
                mappedAccount.gnucash_account_guid,
                match.symbol,
                holdingDesc,
              );
              isSymbolMatched = true;
            } else {
              // No symbol match -- route to Cash child
              targetAccountGuid = cashChildGuid!;
              isSymbolMatched = false;
            }

            await importInvestmentTransaction(
              sfTxn,
              targetAccountGuid,
              cashChildGuid!,
              isSymbolMatched,
              currencyGuid,
              currencyMnemonic,
              bookGuid,
              mappedAccount.gnucash_account_guid,
            );
            result.investmentTransactionsImported++;
          } else {
            // Normal mode: route directly to mapped account
            await importTransaction(
              sfTxn,
              mappedAccount.gnucash_account_guid,
              currencyGuid,
              currencyMnemonic,
              bookGuid
            );
          }
          result.transactionsImported++;
          existingIds.add(sfTxn.id); // Prevent re-import within same sync
        } catch (err) {
          result.errors.push({
            account: mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id,
            error: `Failed to import transaction ${sfTxn.id}: ${err}`,
          });
        }
      }
```

**Step 7: Handle undefined transactions for investment accounts**

In the same `syncSimpleFin` function, find the early-continue check (lines 113-116):

```typescript
    const sfAccount = sfAccountMap.get(mappedAccount.simplefin_account_id);
    if (!sfAccount || !sfAccount.transactions) {
      continue;
    }
```

Replace with:

```typescript
    const sfAccount = sfAccountMap.get(mappedAccount.simplefin_account_id);
    if (!sfAccount) {
      continue;
    }

    // Investment accounts with holdings but no transactions should still be processed
    // to ensure child accounts are created from holdings data
    if (!sfAccount.transactions || sfAccount.transactions.length === 0) {
      if (mappedAccount.is_investment && sfAccount.holdings && sfAccount.holdings.length > 0) {
        // Pre-create child accounts from holdings so they appear in the account tree
        const holdingsSymbolSet = buildSymbolSet(sfAccount.holdings);
        for (const [symbol, desc] of holdingsSymbolSet) {
          try {
            await getOrCreateChildAccount(mappedAccount.gnucash_account_guid, symbol, desc);
          } catch (err) {
            result.errors.push({
              account: mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id,
              error: `Failed to create child account for ${symbol}: ${err}`,
            });
          }
        }
        await getOrCreateCashChild(mappedAccount.gnucash_account_guid);
        result.accountsProcessed++;
      }
      continue;
    }
```

**Step 8: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 9: Commit**

```bash
git add src/lib/services/simplefin-sync.service.ts
git commit -m "feat: add investment mode routing with importInvestmentTransaction to SimpleFin sync engine

Investment transactions route to STOCK child accounts by symbol with
Cash child as counter-account. Unmatched transactions route to Cash
child with guessCategory counter-account.

Phase 1 limitation: quantity stored in dollar terms, not shares.
SimpleFin lacks per-transaction share data."
```

**Acceptance criteria:**
- `npx tsc --noEmit` passes
- Investment accounts route symbol-matched transactions to STOCK child, counter = Cash child
- Unmatched transactions route to Cash child, counter = guessCategory
- Normal (non-investment) accounts continue to work via `importTransaction` as before
- Child accounts and commodities are auto-created when missing
- Holdings-only accounts (no transactions) still get child accounts created
- `SyncResult.investmentTransactionsImported` tracks investment import count
- Code contains prominent comments about Phase 1 dollar-as-quantity limitation
- Code contains comment explaining why `trading-accounts.ts` is not used

---

### Task 5: Update Accounts API to Pass `hasHoldings` Flag

**Files:**
- Modify: `src/app/api/simplefin/accounts/route.ts`

**Step 1: Add `is_investment` to the mappings query**

Find the mappings query (lines 34-42):

```typescript
    const mappings = await prisma.$queryRaw<{
      simplefin_account_id: string;
      gnucash_account_guid: string | null;
      last_sync_at: Date | null;
    }[]>`
      SELECT simplefin_account_id, gnucash_account_guid, last_sync_at
      FROM gnucash_web_simplefin_account_map
      WHERE connection_id = ${connection.id}
    `;
```

Replace with:

```typescript
    const mappings = await prisma.$queryRaw<{
      simplefin_account_id: string;
      gnucash_account_guid: string | null;
      last_sync_at: Date | null;
      is_investment: boolean;
    }[]>`
      SELECT simplefin_account_id, gnucash_account_guid, last_sync_at, is_investment
      FROM gnucash_web_simplefin_account_map
      WHERE connection_id = ${connection.id}
    `;
```

**Step 2: Add `hasHoldings` and `isInvestment` to the response**

Find the response mapping (lines 46-58):

```typescript
    const accounts = accountSet.accounts.map(acc => {
      const mapping = mappingMap.get(acc.id);
      return {
        id: acc.id,
        name: acc.name,
        institution: acc.org?.name || null,
        currency: acc.currency,
        balance: acc.balance,
        availableBalance: acc['available-balance'] || null,
        gnucashAccountGuid: mapping?.gnucash_account_guid || null,
        lastSyncAt: mapping?.last_sync_at || null,
        isMapped: !!mapping?.gnucash_account_guid,
      };
    });
```

Replace with:

```typescript
    const accounts = accountSet.accounts.map(acc => {
      const mapping = mappingMap.get(acc.id);
      return {
        id: acc.id,
        name: acc.name,
        institution: acc.org?.name || null,
        currency: acc.currency,
        balance: acc.balance,
        availableBalance: acc['available-balance'] || null,
        gnucashAccountGuid: mapping?.gnucash_account_guid || null,
        lastSyncAt: mapping?.last_sync_at || null,
        isMapped: !!mapping?.gnucash_account_guid,
        hasHoldings: Array.isArray(acc.holdings) && acc.holdings.length > 0,
        isInvestment: mapping?.is_investment ?? false,
      };
    });
```

**Note:** We access `acc.holdings` directly since Task 2 adds `holdings` to the `SimpleFinAccount` interface. No type casting needed.

**Step 3: Commit**

```bash
git add src/app/api/simplefin/accounts/route.ts
git commit -m "feat: pass hasHoldings and isInvestment flags in SimpleFin accounts API"
```

**Acceptance criteria:**
- `npx tsc --noEmit` passes
- API response includes `hasHoldings: boolean` and `isInvestment: boolean` per account

---

### Task 6: Update Account Map API to Accept `is_investment`

**Files:**
- Modify: `src/app/api/simplefin/accounts/map/route.ts`

**Step 1: Add `isInvestment` to destructuring**

Find the destructuring at line 32:

```typescript
      const { simpleFinAccountId, simpleFinAccountName, simpleFinInstitution, simpleFinLast4, gnucashAccountGuid } = mapping;
```

Replace with:

```typescript
      const { simpleFinAccountId, simpleFinAccountName, simpleFinInstitution, simpleFinLast4, gnucashAccountGuid, isInvestment } = mapping;
```

**Step 2: Update the SQL INSERT/UPSERT**

Find the SQL statement (lines 36-47):

```typescript
      await prisma.$executeRaw`
        INSERT INTO gnucash_web_simplefin_account_map
          (connection_id, simplefin_account_id, simplefin_account_name, simplefin_institution, simplefin_last4, gnucash_account_guid)
        VALUES
          (${connectionId}, ${simpleFinAccountId}, ${simpleFinAccountName || null}, ${simpleFinInstitution || null}, ${simpleFinLast4 || null}, ${gnucashAccountGuid || null})
        ON CONFLICT (connection_id, simplefin_account_id)
        DO UPDATE SET
          gnucash_account_guid = ${gnucashAccountGuid || null},
          simplefin_account_name = COALESCE(${simpleFinAccountName || null}, gnucash_web_simplefin_account_map.simplefin_account_name),
          simplefin_institution = COALESCE(${simpleFinInstitution || null}, gnucash_web_simplefin_account_map.simplefin_institution),
          simplefin_last4 = COALESCE(${simpleFinLast4 || null}, gnucash_web_simplefin_account_map.simplefin_last4)
      `;
```

Replace with:

```typescript
      await prisma.$executeRaw`
        INSERT INTO gnucash_web_simplefin_account_map
          (connection_id, simplefin_account_id, simplefin_account_name, simplefin_institution, simplefin_last4, gnucash_account_guid, is_investment)
        VALUES
          (${connectionId}, ${simpleFinAccountId}, ${simpleFinAccountName || null}, ${simpleFinInstitution || null}, ${simpleFinLast4 || null}, ${gnucashAccountGuid || null}, ${isInvestment ?? false})
        ON CONFLICT (connection_id, simplefin_account_id)
        DO UPDATE SET
          gnucash_account_guid = ${gnucashAccountGuid || null},
          is_investment = ${isInvestment ?? false},
          simplefin_account_name = COALESCE(${simpleFinAccountName || null}, gnucash_web_simplefin_account_map.simplefin_account_name),
          simplefin_institution = COALESCE(${simpleFinInstitution || null}, gnucash_web_simplefin_account_map.simplefin_institution),
          simplefin_last4 = COALESCE(${simpleFinLast4 || null}, gnucash_web_simplefin_account_map.simplefin_last4)
      `;
```

**Step 3: Commit**

```bash
git add src/app/api/simplefin/accounts/map/route.ts
git commit -m "feat: accept is_investment flag in SimpleFin account mapping API"
```

**Acceptance criteria:**
- `npx tsc --noEmit` passes
- PUT request with `isInvestment: true` in a mapping persists the value

---

### Task 7: Update Settings Page UI with Investment Toggle

**Files:**
- Modify: `src/app/(main)/settings/page.tsx`

**Step 1: Update the `SimpleFinAccount` interface**

Find the interface at lines 20-30:

```typescript
interface SimpleFinAccount {
  id: string;
  name: string;
  institution: string | null;
  currency: string;
  balance: string;
  availableBalance: string | null;
  gnucashAccountGuid: string | null;
  lastSyncAt: string | null;
  isMapped: boolean;
}
```

Replace with:

```typescript
interface SimpleFinAccount {
  id: string;
  name: string;
  institution: string | null;
  currency: string;
  balance: string;
  availableBalance: string | null;
  gnucashAccountGuid: string | null;
  lastSyncAt: string | null;
  isMapped: boolean;
  hasHoldings: boolean;
  isInvestment: boolean;
}
```

**Step 2: Update `handleSfMapAccount` to pass `isInvestment`**

Find the `handleSfMapAccount` function (starts at line 295). The request body currently sends:

```typescript
        body: JSON.stringify({
          mappings: [{
            simpleFinAccountId: sfAccountId,
            simpleFinAccountName: sfAccount.name,
            simpleFinInstitution: sfAccount.institution,
            gnucashAccountGuid: gnucashGuid || null,
          }],
        }),
```

Replace with:

```typescript
        body: JSON.stringify({
          mappings: [{
            simpleFinAccountId: sfAccountId,
            simpleFinAccountName: sfAccount.name,
            simpleFinInstitution: sfAccount.institution,
            gnucashAccountGuid: gnucashGuid || null,
            isInvestment: sfAccount.isInvestment,
          }],
        }),
```

**Step 3: Add a handler for toggling investment mode**

After the `handleSfMapAccount` function (ends around line 322), add:

```typescript
  const handleSfToggleInvestment = async (sfAccountId: string, isInvestment: boolean, sfAccount: SimpleFinAccount) => {
    try {
      const res = await fetch('/api/simplefin/accounts/map', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: [{
            simpleFinAccountId: sfAccountId,
            simpleFinAccountName: sfAccount.name,
            simpleFinInstitution: sfAccount.institution,
            gnucashAccountGuid: sfAccount.gnucashAccountGuid,
            isInvestment,
          }],
        }),
      });
      if (res.ok) {
        setSfAccounts(prev => prev.map(a =>
          a.id === sfAccountId ? { ...a, isInvestment } : a
        ));
      } else {
        showError('Failed to update investment setting');
      }
    } catch {
      showError('Failed to update investment setting');
    }
  };
```

**Step 4: Update the mapping table rows with investment toggle**

Find the `<td>` that contains the `AccountSelector` (lines 691-696):

```tsx
                        <td className="px-4 py-2">
                          <AccountSelector
                            value={account.gnucashAccountGuid || ''}
                            onChange={(guid) => handleSfMapAccount(account.id, guid, account)}
                            placeholder="Select account..."
                          />
                        </td>
```

Replace with:

```tsx
                        <td className="px-4 py-2">
                          <AccountSelector
                            value={account.gnucashAccountGuid || ''}
                            onChange={(guid) => handleSfMapAccount(account.id, guid, account)}
                            placeholder="Select account..."
                          />
                          {account.isMapped && (
                            <label className="flex items-center gap-1.5 mt-1 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={account.isInvestment}
                                onChange={(e) => handleSfToggleInvestment(account.id, e.target.checked, account)}
                                className="w-3 h-3 text-cyan-500 bg-background-tertiary border-border-hover rounded focus:ring-cyan-500/50"
                              />
                              <span className="text-[10px] text-foreground-muted">
                                Investment (routes to child accounts by symbol)
                              </span>
                            </label>
                          )}
                        </td>
```

**Step 5: Auto-detect investment mode from `hasHoldings` (ONLY for unmapped accounts)**

Find the `fetchSimplefinAccounts` callback (lines 116-126):

```typescript
  const fetchSimplefinAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/simplefin/accounts');
      if (res.ok) {
        const data = await res.json();
        setSfAccounts(data.accounts || []);
      }
    } catch {
      // Silently fail
    }
  }, []);
```

Replace with:

```typescript
  const fetchSimplefinAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/simplefin/accounts');
      if (res.ok) {
        const data = await res.json();
        const accounts = (data.accounts || []).map((a: SimpleFinAccount) => ({
          ...a,
          // Auto-detect: suggest investment mode for NEW unmapped accounts with holdings.
          // Once an account has a mapping row (isMapped or explicitly toggled), respect
          // the DB value. This prevents overriding a user's explicit disable on every page load.
          isInvestment: a.isInvestment || (a.hasHoldings && !a.isMapped),
        }));
        setSfAccounts(accounts);
      }
    } catch {
      // Silently fail
    }
  }, []);
```

**CRITICAL: Why `a.isInvestment || (a.hasHoldings && !a.isMapped)` instead of `a.isInvestment || a.hasHoldings`:**

| Scenario | `a.isInvestment` (from DB) | `a.hasHoldings` | `a.isMapped` | Result | Correct? |
|----------|---------------------------|-----------------|--------------|--------|----------|
| New account with holdings, not yet mapped | `false` | `true` | `false` | `true` (auto-suggest) | YES - suggests investment mode for new brokerage accounts |
| Mapped account, user enabled investment | `true` | `true` | `true` | `true` (from DB) | YES - respects DB |
| Mapped account, user DISABLED investment | `false` | `true` | `true` | `false` (from DB) | YES - respects user's explicit disable |
| Mapped bank account, no holdings | `false` | `false` | `true` | `false` | YES - normal bank account |

With the old logic `a.isInvestment || a.hasHoldings`, row 3 would be `true`, overriding the user's disable every page load. The new logic only auto-enables for accounts that have NO mapping row yet.

**Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```bash
git add "src/app/(main)/settings/page.tsx"
git commit -m "feat: add investment mode toggle to SimpleFin account mapping UI

Auto-detects investment mode for new unmapped accounts with holdings.
Respects user's explicit toggle once a mapping row exists."
```

**Acceptance criteria:**
- `npx tsc --noEmit` passes
- Investment checkbox appears below AccountSelector for mapped accounts
- Checkbox auto-checked for NEW unmapped accounts with holdings
- Checkbox NOT auto-overridden for already-mapped accounts (respects DB value)
- Toggling checkbox persists to database via map API
- Non-mapped accounts don't show the toggle

---

### Task 8: Verify Full Build and Push

**Step 1: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 2: Run ESLint**

Run: `npm run lint`
Expected: No errors (or only pre-existing warnings)

**Step 3: Run full build**

Run: `npm run build`
Expected: `Compiled successfully` with all routes generated

**Step 4: Manual smoke test checklist**

1. Navigate to Settings page
2. Verify bank connections section loads
3. If SimpleFin is connected, verify account mapping table shows
4. Verify investment checkbox appears on mapped accounts
5. Verify checkbox auto-checks for NEW unmapped accounts with holdings
6. Verify checkbox does NOT auto-check for already-mapped accounts where user previously disabled it
7. Toggle checkbox and refresh -- verify it persists
8. Trigger a sync and verify no errors in console
9. Check that investment transactions appear under correct child accounts
10. Verify `SyncResult` includes `investmentTransactionsImported` count

**Step 5: Commit any remaining fixes, then push**

```bash
git push
```

---

## File Change Summary

| File | Change | Lines Affected |
|------|--------|----------------|
| `src/lib/db-init.ts` | Add `is_investment` column DDL + execution | ~356-387 |
| `src/lib/services/simplefin.service.ts` | Add `SimpleFinHolding` interface, `holdings` field, fix chunk merge | ~73-88, ~196-208 |
| `src/lib/services/simplefin-symbol-parser.ts` | **NEW FILE** - Symbol parsing service | N/A |
| `src/lib/services/simplefin-sync.service.ts` | Add imports, `importInvestmentTransaction`, helper functions, investment routing, holdings-only handling, `SyncResult.investmentTransactionsImported` | ~8-17, ~23-28, ~56-66, ~113-116, ~155-178, ~391+ |
| `src/app/api/simplefin/accounts/route.ts` | Add `is_investment` to query, `hasHoldings`/`isInvestment` to response | ~34-58 |
| `src/app/api/simplefin/accounts/map/route.ts` | Accept `isInvestment` in upsert | ~32-47 |
| `src/app/(main)/settings/page.tsx` | Interface update, toggle handler, UI toggle, auto-detect with isMapped guard | ~20-30, ~295-322, ~116-126, ~691-696 |

**Files explicitly NOT modified (with explanation):**
| File | Why Not Modified |
|------|------------------|
| `src/lib/trading-accounts.ts` | Not used. See "Known Limitations" section. GnuCash desktop defaults don't use trading accounts for stock purchases, and Phase 1's value==quantity approach means no quantity imbalance exists. |

## Dependencies

```
Task 1 (schema) --> Task 4 (sync engine needs column)
                --> Task 6 (map API writes column)

Task 2 (types) --> Task 3 (symbol parser imports types)
               --> Task 4 (sync engine uses holdings)
               --> Task 5 (accounts API uses holdings)

Task 3 (parser) --> Task 4 (sync engine uses parser)

Tasks 1-6 --> Task 7 (UI depends on API changes)
All --> Task 8 (verification)
```

Tasks 1, 2, and 3 can be done in parallel. Task 4 depends on 1, 2, and 3. Tasks 5 and 6 depend on 1 and 2. Task 7 depends on 5 and 6. Task 8 depends on all.

## Edge Cases Handled

1. **No holdings data** -- `symbolSet` is empty, all transactions route to Cash child
2. **Symbol not in holdings** -- routes to Cash child, counter-account from `guessCategory`
3. **Commodity already exists in GnuCash** -- `findFirst` by mnemonic reuses it
4. **Child account already exists** -- SQL JOIN finds existing child by commodity mnemonic
5. **Multiple tickers in description** -- takes first match (highest priority strategy wins)
6. **Holdings lost in chunked fetch** -- fixed by preserving holdings in merge logic
7. **Toggle investment after mapping** -- separate toggle handler updates only `is_investment`
8. **Account hierarchy view** -- is a regular VIEW, auto-includes new child accounts
9. **Investment account with holdings but no transactions** -- pre-creates child accounts from holdings data so they appear in the account tree immediately
10. **User disables investment on mapped account with holdings** -- auto-detect does NOT override because `!a.isMapped` is false for already-mapped accounts
11. **STOCK split value/quantity** -- Phase 1 stores dollar amounts for both (documented limitation), not shares

## Critic Issue Resolution Checklist

| # | Issue | Resolution |
|---|-------|------------|
| 1 | VALUE/QUANTITY PROBLEM | New `importInvestmentTransaction` function with explicit comments: `quantity_num == value_num` (dollar terms). Prominent `// TODO Phase 2` comment. See "Known Limitations" section. |
| 2 | `currencyGuid` wrong for STOCK child | Transaction currency is USD (correct). Both value and quantity use dollar amounts. Phase 1 limitation documented. |
| 3 | `trading-accounts.ts` ignored | Explicitly documented why not used in "Known Limitations", in `importInvestmentTransaction` JSDoc, and in File Change Summary. |
| 4 | Auto-detect defeats user toggle | Changed from `a.isInvestment \|\| a.hasHoldings` to `a.isInvestment \|\| (a.hasHoldings && !a.isMapped)`. Truth table provided in Task 7 Step 5. |
| 5 | Missing handling of undefined transactions | Task 4 Step 7: investment accounts with holdings but no transactions pre-create child accounts from holdings data. |
