# SimpleFin Investment Account Routing - Design

**Date:** 2026-02-19
**Status:** Approved

## Problem

The current SimpleFin integration maps one bank account to one GnuCash account (1:1). This works for checking/savings accounts but not for brokerage/investment accounts, where GnuCash uses a parent account with child accounts per commodity (e.g., `Assets:Investments:Brokerage` with children `VOO`, `AAPL`, `Cash`).

## Goal

Enable SimpleFin brokerage accounts to be mapped to a GnuCash parent investment account, with the sync engine automatically routing each transaction to the correct child account based on the stock symbol.

## SimpleFin API Data

SimpleFin Bridge returns additional data for brokerage accounts beyond the official protocol spec:

**Holdings array (per account):**
```json
{
  "holdings": [
    {
      "symbol": "VOO",
      "shares": "100.03",
      "cost_basis": "90000.00",
      "market_value": "100000.00",
      "description": "VANGUARD INDEX FUNDS S&P 500 ETF USD"
    }
  ]
}
```

**Transactions (tickers embedded in description):**
```
"YOU BOUGHT VANGUARD INDEX FUNDS S&P 500 ETF USD (VOO) (Cash) Cash"
"DIVIDEND [AAPL]"
"SOLD MSFT 10 SHARES"
```

There is no structured symbol field on transactions - tickers must be parsed from descriptions.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Detection method | Auto-detect from holdings + user toggle override | Reliable automatic detection with manual escape hatch |
| Unmatched transactions | Dedicated cash child account | Clean separation; user can reclassify later |
| Missing child accounts | Auto-create as STOCK type | Low friction; user can reclassify account type later |
| Holdings data usage | Routing/validation only | Avoids complexity of reconciling share counts |
| Account type for auto-created children | Always STOCK | Simple default; covers most cases |
| UI presentation | Same row with indicator/toggle | Consistent UI, low visual complexity |

## Architecture

### Detection

Investment mode is determined by:
1. **Auto-detect:** SimpleFin account has a `holdings` array in API response
2. **User override:** Toggle on the mapping row to manually enable/disable
3. **Stored:** `is_investment` boolean on `gnucash_web_simplefin_account_map`

No reliance on the GnuCash account being a placeholder - works with any parent account type.

### Sync Flow (Investment Mode)

```
1. Fetch SimpleFin data (includes holdings + transactions)
2. Build symbol set from holdings: {VOO, AAPL, MSFT}
3. For each transaction:
   a. Parse description for ticker symbol
   b. Validate against holdings symbol set
   c. If matched:
      - Find child account with matching commodity under parent
      - If no child exists:
        - Look up or create commodity in GnuCash commodities table
        - Create STOCK child account with that commodity
      - Create split on child account
   d. If unmatched:
      - Route to [Parent]:Cash child (auto-create if needed)
4. All transactions marked source='simplefin', reviewed=FALSE
```

### Symbol Parser

Extract ticker symbols from transaction descriptions using multiple strategies:

```
Pattern                          Example                              Result
─────────────────────────────────────────────────────────────────────────────
Parenthesized ticker             "BOUGHT ... (VOO) ..."               VOO
Bracketed ticker                 "DIVIDEND [AAPL]"                    AAPL
Known symbol in text             "SOLD MSFT 10 SHARES"                MSFT
Holding description match        "VANGUARD S&P 500 ETF" matches VOO   VOO
```

Strategy: Extract candidate uppercase words (1-5 chars), validate against the holdings symbol set.

### Schema Change

```sql
ALTER TABLE gnucash_web_simplefin_account_map
  ADD COLUMN is_investment BOOLEAN NOT NULL DEFAULT FALSE;
```

### Auto-Create Child Account

When a matched symbol has no corresponding child account:

1. Look up commodity by symbol in `commodities` table (namespace matches common exchanges)
2. If commodity doesn't exist, create it (symbol, namespace='UNKNOWN', fullname from holdings description)
3. Create child account: `name=SYMBOL`, `account_type='STOCK'`, `commodity_guid=commodity.guid`, `parent_guid=mapped_parent`

### Auto-Create Cash Child

When a transaction has no matched symbol:

1. Look for existing child named "Cash" under the parent
2. If not found, create it: `name='Cash'`, `account_type` matching parent's type, `commodity_guid` matching parent's commodity (USD)

### Settings UI

Same mapping table row, with additional indicator:

```
┌──────────────────────────┬──────────────────────────────────────┬──────────┐
│ Fidelity Brokerage       │ Assets:Investments:Brokerage ▾       │  Mapped  │
│ Fidelity | USD | $100k   │ ☑ Investment (routes to children)    │          │
└──────────────────────────┴──────────────────────────────────────┴──────────┘
```

- Checkbox auto-checked when `holdings` detected, user can toggle
- Subtitle text explains the routing behavior
- Toggle persists to `is_investment` column

## Files Affected

### New Files
- `src/lib/services/simplefin-symbol-parser.ts` - Ticker extraction from descriptions

### Modified Files
- `src/lib/services/simplefin.service.ts` - Add `holdings` to SimpleFinAccount interface
- `src/lib/services/simplefin-sync.service.ts` - Investment mode branch in sync logic
- `src/lib/db-init.ts` - Add `is_investment` column to account map table
- `src/app/api/simplefin/accounts/route.ts` - Pass `hasHoldings` flag to frontend
- `src/app/api/simplefin/accounts/map/route.ts` - Accept `is_investment` in mapping
- `src/app/(main)/settings/page.tsx` - Investment toggle on mapping rows

## Edge Cases

1. **Holdings not provided** - Some brokers don't return holdings; user can manually toggle investment mode, but symbol parsing will be less reliable without validation
2. **Symbol collision** - A word like "USD" or "ETF" matching a real ticker; mitigated by only matching against known holdings symbols
3. **Multiple tickers in one description** - Take the first match against holdings
4. **Commodity not in GnuCash** - Auto-create with namespace='UNKNOWN'; user can fix later
5. **Parent has no children yet** - First sync auto-creates all needed children
