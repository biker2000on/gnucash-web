# Investment Ledger Design

## Overview

Replace the standard debit/credit ledger with an investment-specific column layout when viewing STOCK or MUTUAL accounts. The investment ledger reuses the existing `AccountLedger` component infrastructure (infinite scroll, keyboard navigation, reconciliation) but swaps column definitions and edit mode behavior.

## Detection

An account is treated as an investment account when `commodity_namespace !== 'CURRENCY'` (same logic already used in the codebase). The `commodityNamespace` is passed as a new prop to `AccountLedger` from the account page.

## Columns

| Column | Source | Alignment | Notes |
|--------|--------|-----------|-------|
| Date | `post_date` | Left | Same as current |
| Description | `description` | Left | Same as current |
| Transfer | Primary non-trading, non-self split's `account_fullname` | Left | Dropdown in edit mode, filtered to non-investment accounts. For multi-split transactions (e.g., with commission), show the primary cash account |
| Shares | Account split's `quantity_decimal` | Right | Green positive (buy), red negative (sell). Blank for non-share transactions |
| Price | Derived: `|account_split.value_decimal| / |account_split.quantity_decimal|` | Right | Formatted in transaction currency. Blank when shares is zero |
| Buy | `|account_split.value_decimal|` when shares > 0 | Right | Green text, always displayed positive. Blank for sells |
| Sell | `|account_split.value_decimal|` when shares < 0 | Right | Red text, always displayed positive. Blank for buys |
| Share Bal | Running cumulative shares | Right | Seeded from API `starting_share_balance` for paginated views |
| Cost Basis | Running cumulative cost basis | Right | Seeded from API `starting_cost_basis` for paginated views |

### Field Clarification

For stock accounts, the account split has two distinct numeric fields:
- `quantity_num / quantity_denom` → **shares** (in the account's commodity, e.g., 10 shares of AAPL)
- `value_num / value_denom` → **monetary value** (in the transaction's currency, e.g., $1,500 USD)

Price is derived from the account split alone: `|value| / |quantity|`. The Buy/Sell total also comes from the account split's `value_decimal` (absolute value). There is no need to look at the cash split for these columns.

## Transaction Types

**Buy:** Shares positive, amount in Buy column. Share balance increases, cost basis increases by `|account_split.value_decimal|`.

**Sell:** Shares negative (displayed as negative), amount in Sell column (displayed positive). Share balance decreases. Cost basis decreases by average cost method: `(|shares_sold| / shares_held_before_sell) × current_cost_basis`.

**DRIP / Reinvested Dividend:** Shows as a buy with an Income account as the transfer. Share balance and cost basis both increase. Cost basis uses `|account_split.value_decimal|` (same as a regular buy).

**Cash Dividend (non-reinvested):** No shares change (account split quantity is zero). Shares, Price, Buy, Sell columns are all blank. Balances unchanged. Row shows date, description, and transfer account (Income:Dividends).

## Data Transformation

Transformation is client-side from the existing split data:

1. Find the "account split" (matching current account guid):
   - `shares = quantity_num / quantity_denom`
   - `total = value_num / value_denom` (monetary value, may be negative per GnuCash convention)
2. For display: `price = |total| / |shares|` (when shares != 0)
3. For Buy column: `|total|` when shares > 0
4. For Sell column: `|total|` when shares < 0
5. Determine transaction type by shares sign (positive = buy, negative = sell, zero = dividend/other)
6. For Transfer column: find the primary non-trading, non-self split. If multiple non-trading splits exist (e.g., cash + commission expense), show the one with the largest `|value_decimal|` (the cash account)
7. Running share balance and cost basis: seeded from API response, then accumulated client-side within the current page

### Multi-Split Transactions (Commissions)

Transactions may have 3+ splits (stock + cash + expense). Behavior:
- Transfer column shows the primary cash account (largest non-trading, non-self split by value)
- Buy/Sell total shows the account split's `|value_decimal|` (gross amount including commission baked into the per-share price)
- Inline editing is disabled for 3+ split transactions — they show as expandable rows (same as existing multi-split behavior in `AccountLedger`)

## API Changes

**`/api/accounts/[guid]/transactions`** — add two fields to the response when the account is an investment account:

- `starting_share_balance: string` — cumulative share balance at the start of the current page (sum of all `quantity_decimal` for transactions before the current page's offset)
- `starting_cost_basis: string` — cumulative cost basis at the start of the current page (computed server-side using average cost method)

These are analogous to the existing `startingBalance` field used for monetary running balance. They enable correct running totals with paginated infinite scroll.

## Edit Mode

Matches existing ledger keyboard-driven inline editing:

- **Enter** on a row → enters edit mode (only for simple 2-split transactions)
- **Arrow up/down** or **Enter** while editing → saves current row, moves to next/previous
- **Escape** → cancels, reverts to original values
- **Tab** → moves between fields: Date → Description → Transfer → Shares → Price → Buy/Sell
- Tab lands on Buy by default; user can Tab again to reach Sell (entering a value in Sell clears Buy and vice versa)

### Auto-Calculation (3-field triangle)

Default: user enters **Shares** + **Buy or Sell total** → **Price** auto-calculates (shown dimmed/italic).

If user tabs into Price and types a value → **Total (Buy/Sell)** becomes the auto-calculated field instead.

The auto-calculated field is always derivable from the other two: `Total = Shares × Price`.

**Buy vs Sell determination:** Entering a value in the Buy column makes shares positive. Entering a value in the Sell column makes shares negative. The shares field sign is auto-set based on which column receives input.

### On Submit

1. Create the stock account split (shares as quantity, total as value — value is negative for buys per GnuCash convention)
2. Create the cash/transfer account split (opposite value)
3. Auto-generate trading splits via existing `processMultiCurrencySplits()`

## Architecture

### Modified Files

**`src/components/ledger/columns.tsx`**
- Add `investmentColumns` column definition array
- Add `transformToInvestmentRow()` helper that extracts shares, price, buy/sell, transfer from raw transaction splits

**`src/components/AccountLedger.tsx`**
- Accept new `commodityNamespace` prop
- Detect investment account via `commodityNamespace !== 'CURRENCY'`
- Use `investmentColumns` instead of default `columns` when investment
- Transform each `AccountTransaction` through `transformToInvestmentRow()` before rendering
- Adapt running balance calculation: track share balance + cost basis using API seed values, then accumulate within the page

**`src/app/(main)/accounts/[guid]/page.tsx`**
- Remove the `isInvestmentAccount` branch that renders the separate `InvestmentAccount` component
- All accounts route through `AccountLedger` (which internally adapts columns)
- Extract price chart and holdings summary from `InvestmentAccount` into a header section above the ledger (remove the "Transaction History" table from `InvestmentAccount` — that is replaced by the new investment columns in `AccountLedger`)
- Pass `commodityNamespace` prop to `AccountLedger`

**`src/app/api/accounts/[guid]/transactions/route.ts`**
- When account is an investment type, compute and return `starting_share_balance` and `starting_cost_basis` alongside existing response fields

### New File

**`src/components/ledger/InvestmentEditRow.tsx`**
- Inline edit form with the 3-field auto-calc triangle (shares/price/total)
- Transfer account dropdown (filtered to non-investment accounts)
- Keyboard-driven: no save/cancel buttons, same UX as existing edit rows
- On submit: creates splits and calls `processMultiCurrencySplits()` for trading accounts

## Reconciliation

Reconciliation works the same as the standard ledger. The reconcile state shown is for the stock account split (the `account_split_reconcile_state` already returned by the API). This is the natural choice since the ledger is viewed from the stock account's perspective.

## Out of Scope

- Stock splits (share multiplication without money exchange)
- Return of capital
- Inline editing of multi-split transactions (3+ splits, e.g., with commissions)
- Lot-specific cost basis (uses average cost method only)
- Dedicated dividend column (cash dividends show as rows with blank investment columns)
