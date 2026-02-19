# SimpleFin Investment Account Routing - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route SimpleFin brokerage transactions to child stock accounts under a mapped parent investment account, with auto-creation of child accounts and a cash fallback.

**Architecture:** When a SimpleFin account has holdings (or user toggles investment mode), the sync engine parses ticker symbols from transaction descriptions, validates them against the holdings symbol set, and routes each transaction to the matching child STOCK account under the mapped GnuCash parent. Unmatched transactions go to a `Cash` child. Missing child accounts and commodities are auto-created.

**Tech Stack:** Next.js 16, TypeScript, Prisma raw SQL, PostgreSQL, React 19

---

### Task 1: Add `is_investment` Column to Account Map Table

**Files:**
- Modify: `src/lib/db-init.ts:356-369`

**Step 1: Add the column in db-init**

In `src/lib/db-init.ts`, find the `simpleFinAccountMapTableDDL` string (line 356) and add an `is_investment` column. Also add a separate `ALTER TABLE` DDL to handle existing databases.

After the existing `simpleFinAccountMapTableDDL` variable (line 369), add a new variable:

```typescript
const simpleFinAccountMapAddInvestmentDDL = `
    ALTER TABLE gnucash_web_simplefin_account_map
    ADD COLUMN IF NOT EXISTS is_investment BOOLEAN NOT NULL DEFAULT FALSE;
`;
```

Then find where `simpleFinAccountMapTableDDL` is executed (around line 388) and add this new DDL right after it:

```typescript
await query(simpleFinAccountMapAddInvestmentDDL);
```

**Step 2: Verify the migration runs**

Run: `npm run dev` and check the console for `Extension tables created/verified successfully` with no errors.

**Step 3: Commit**

```bash
git add src/lib/db-init.ts
git commit -m "feat: add is_investment column to simplefin account map table"
```

---

### Task 2: Add `holdings` to SimpleFin API Types

**Files:**
- Modify: `src/lib/services/simplefin.service.ts:65-93`

**Step 1: Add holdings interface and update SimpleFinAccount**

In `src/lib/services/simplefin.service.ts`, add a `SimpleFinHolding` interface before `SimpleFinAccount` (after line 73), and add `holdings?` to `SimpleFinAccount`:

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

**Step 2: Commit**

```bash
git add src/lib/services/simplefin.service.ts
git commit -m "feat: add holdings interface to SimpleFin API types"
```

---

### Task 3: Create Symbol Parser Service

**Files:**
- Create: `src/lib/services/simplefin-symbol-parser.ts`

**Step 1: Implement the symbol parser**

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
  // Extract all uppercase words 1-5 chars, check against symbol set
  const words = upper.match(/\b([A-Z]{1,5})\b/g) || [];
  // Filter out common non-ticker words
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

---

### Task 4: Add Investment Mode to Sync Engine

**Files:**
- Modify: `src/lib/services/simplefin-sync.service.ts:1-422`

This is the largest task. The sync engine needs an investment-mode branch that:
- Detects `is_investment` on the mapped account
- Builds a symbol set from holdings
- Parses each transaction's description for a ticker
- Routes to the correct child account (or auto-creates it)
- Falls back to a Cash child for unmatched transactions

**Step 1: Add imports and helper functions**

At the top of `src/lib/services/simplefin-sync.service.ts`, add imports after line 3:

```typescript
import { buildSymbolSet, parseSymbol } from './simplefin-symbol-parser';
import type { SimpleFinHolding } from './simplefin.service';
```

After the `getOrCreateImbalanceAccount` function (after line 391), add these new helper functions:

```typescript
/**
 * Find or create a child account under the parent for a given stock symbol.
 * Creates the commodity if it doesn't exist, then creates a STOCK child account.
 */
async function getOrCreateChildAccount(
  parentGuid: string,
  symbol: string,
  holdingDescription: string,
  bookGuid: string
): Promise<string> {
  // Get parent account info
  const parent = await prisma.accounts.findUnique({
    where: { guid: parentGuid },
  });
  if (!parent) throw new Error(`Parent account ${parentGuid} not found`);

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
  // Check if "Cash" child already exists
  const existing = await prisma.accounts.findFirst({
    where: { parent_guid: parentGuid, name: 'Cash' },
  });
  if (existing) return existing.guid;

  // Get parent info for commodity and type
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

**Step 2: Update the mapped accounts query to include `is_investment`**

In the `syncSimpleFin` function, find the mapped accounts query (line 56-66) and update it:

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

**Step 3: Add investment-mode transaction routing**

In the `syncSimpleFin` function, inside the `for (const mappedAccount of mappedAccounts)` loop, after the `currencyMnemonic` variable (around line 153), add the investment-mode branch. Replace the transaction processing loop (lines 155-178) with:

```typescript
      // Build holdings symbol set if investment account
      const sfHoldings: SimpleFinHolding[] = (sfAccount as { holdings?: SimpleFinHolding[] }).holdings || [];
      const symbolSet = mappedAccount.is_investment ? buildSymbolSet(sfHoldings) : new Map();

      for (const sfTxn of sfAccount.transactions) {
        if (existingIds.has(sfTxn.id)) {
          result.transactionsSkipped++;
          continue;
        }

        try {
          if (mappedAccount.is_investment) {
            // Investment mode: route to child account by symbol
            const match = parseSymbol(sfTxn.description || '', symbolSet);
            let targetAccountGuid: string;

            if (match) {
              const holdingDesc = symbolSet.get(match.symbol) || match.symbol;
              targetAccountGuid = await getOrCreateChildAccount(
                mappedAccount.gnucash_account_guid,
                match.symbol,
                holdingDesc,
                bookGuid
              );
            } else {
              // No symbol match — route to Cash child
              targetAccountGuid = await getOrCreateCashChild(
                mappedAccount.gnucash_account_guid,
              );
            }

            await importTransaction(
              sfTxn,
              targetAccountGuid,
              currencyGuid,
              currencyMnemonic,
              bookGuid
            );
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
          existingIds.add(sfTxn.id);
        } catch (err) {
          result.errors.push({
            account: mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id,
            error: `Failed to import transaction ${sfTxn.id}: ${err}`,
          });
        }
      }
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/lib/services/simplefin-sync.service.ts
git commit -m "feat: add investment mode routing to SimpleFin sync engine"
```

---

### Task 5: Update Accounts API to Pass `hasHoldings` Flag

**Files:**
- Modify: `src/app/api/simplefin/accounts/route.ts:1-69`

**Step 1: Add `hasHoldings` and `isInvestment` to the accounts response**

In `src/app/api/simplefin/accounts/route.ts`, update the mappings query (line 34-42) to include `is_investment`:

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

Then update the response mapping (line 46-58) to add the new fields:

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
        hasHoldings: Array.isArray((acc as Record<string, unknown>).holdings) && ((acc as Record<string, unknown>).holdings as unknown[]).length > 0,
        isInvestment: mapping?.is_investment ?? false,
      };
    });
```

**Step 2: Commit**

```bash
git add src/app/api/simplefin/accounts/route.ts
git commit -m "feat: pass hasHoldings and isInvestment flags in SimpleFin accounts API"
```

---

### Task 6: Update Account Map API to Accept `is_investment`

**Files:**
- Modify: `src/app/api/simplefin/accounts/map/route.ts:1-55`

**Step 1: Add `isInvestment` to the upsert**

In `src/app/api/simplefin/accounts/map/route.ts`, update the destructuring on line 32:

```typescript
const { simpleFinAccountId, simpleFinAccountName, simpleFinInstitution, simpleFinLast4, gnucashAccountGuid, isInvestment } = mapping;
```

Update the SQL INSERT statement (lines 36-47) to include `is_investment`:

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

**Step 2: Commit**

```bash
git add src/app/api/simplefin/accounts/map/route.ts
git commit -m "feat: accept is_investment flag in SimpleFin account mapping API"
```

---

### Task 7: Update Settings Page UI with Investment Toggle

**Files:**
- Modify: `src/app/(main)/settings/page.tsx:20-30,295-322,667-714`

**Step 1: Update the `SimpleFinAccount` interface**

In `src/app/(main)/settings/page.tsx`, update the `SimpleFinAccount` interface (line 20) to add the new fields:

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

Update the `handleSfMapAccount` function (line 295) to include `isInvestment`:

```typescript
  const handleSfMapAccount = async (sfAccountId: string, gnucashGuid: string, sfAccount: SimpleFinAccount) => {
    try {
      const res = await fetch('/api/simplefin/accounts/map', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: [{
            simpleFinAccountId: sfAccountId,
            simpleFinAccountName: sfAccount.name,
            simpleFinInstitution: sfAccount.institution,
            gnucashAccountGuid: gnucashGuid || null,
            isInvestment: sfAccount.isInvestment,
          }],
        }),
      });
      if (res.ok) {
        success('Account mapping updated');
        setSfAccounts(prev => prev.map(a =>
          a.id === sfAccountId
            ? { ...a, gnucashAccountGuid: gnucashGuid || null, isMapped: !!gnucashGuid }
            : a
        ));
      } else {
        showError('Failed to update mapping');
      }
    } catch {
      showError('Failed to update mapping');
    }
  };
```

**Step 3: Add a handler for toggling investment mode**

Add a new handler after `handleSfMapAccount`:

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

**Step 4: Update the mapping table rows**

In the account mapping table body (around line 682), update each row to show the investment toggle below the AccountSelector. Replace the `<td>` that contains the `AccountSelector` (lines 691-696):

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

**Step 5: Auto-detect investment mode when `hasHoldings` is true**

In the `fetchSimplefinAccounts` callback (around line 116-126), after setting accounts, auto-set `isInvestment` for accounts with holdings that haven't been explicitly configured yet. Update the callback:

```typescript
  const fetchSimplefinAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/simplefin/accounts');
      if (res.ok) {
        const data = await res.json();
        const accounts = (data.accounts || []).map((a: SimpleFinAccount) => ({
          ...a,
          // Auto-detect: if has holdings and not yet mapped, default isInvestment to true
          isInvestment: a.isInvestment || (a.hasHoldings && !a.isMapped),
        }));
        setSfAccounts(accounts);
      }
    } catch {
      // Silently fail
    }
  }, []);
```

**Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```bash
git add "src/app/(main)/settings/page.tsx"
git commit -m "feat: add investment mode toggle to SimpleFin account mapping UI"
```

---

### Task 8: Verify Full Build and Push

**Step 1: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 2: Run full build**

Run: `npm run build`
Expected: `Compiled successfully` with all routes generated

**Step 3: Manual smoke test**

1. Navigate to Settings page
2. Verify bank connections section loads
3. If SimpleFin is connected, verify account mapping table shows
4. Verify investment checkbox appears on mapped accounts
5. Verify checkbox auto-checks for accounts with holdings

**Step 4: Push**

```bash
git push
```
