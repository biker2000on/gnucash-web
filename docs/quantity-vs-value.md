# GnuCash Split Field Semantics: Quantity vs. Value

## Overview

GnuCash splits store TWO distinct numeric fields that represent amounts in different currencies/units. Understanding when to use each is critical for correctly calculating balances, valuations, and multi-currency transactions.

- **`value_num/value_denom`**: Amount in the **transaction's currency**
- **`quantity_num/quantity_denom`**: Amount in the **account's commodity** (currency for cash accounts, shares for investment accounts)

This distinction becomes especially important in multi-currency and investment portfolios where these values differ.

---

## Field Definitions

### `value_num / value_denom` (Value)

The amount in the **transaction's currency** (also called the transaction's default currency).

**When created:** When you enter a transaction, you specify its currency. Each split's `value` is automatically set to represent that amount in the transaction currency.

**Example:**
```
Transaction: GBP 100
  Splits:
    - Account A (GBP): value = GBP 100
    - Account B (GBP): value = GBP -100
```

**Purpose:**
- Transaction-level display (what you see in journals)
- Multi-currency transaction balancing
- Investment cost basis (cash spent to buy shares)

### `quantity_num / quantity_denom` (Quantity)

The amount in the **account's commodity**.

**When different from value:** When an account's commodity differs from the transaction's currency:
- Cash account in USD, transaction in EUR → `value` = EUR amount, `quantity` = USD amount
- Stock account, transaction in USD → `value` = USD (cost), `quantity` = shares

**Purpose:**
- Account balance summation (what you own in each currency/commodity)
- Share counts in investment accounts
- Multi-currency currency conversion calculations

---

## Same-Currency Transactions

When the transaction currency matches the account's commodity, **`quantity` and `value` are identical**.

```sql
-- USD transaction, USD account
-- Both splits show the same amount
SELECT
  s.value_num,
  s.value_denom,      -- 10000
  s.quantity_num,
  s.quantity_denom    -- 10000 (same)
FROM splits s
WHERE account_guid = '...' AND account commodity = 'USD'
```

**In code:** You may use either field; they give the same result.

---

## Multi-Currency Transactions

When you exchange currencies, `value` and `quantity` differ.

### Example: EUR Account ↔ USD Account

```
Transaction (USD currency):
  Date: 2025-01-15
  Description: Exchange EUR to USD

  Split 1 (EUR account):
    value:    -100 (USD 100 spent)
    quantity: -125 (EUR 125 received)
    → Exchange rate: 1 EUR = 0.80 USD (so 125 EUR = 100 USD)

  Split 2 (USD account):
    value:    100 (USD 100 received)
    quantity: 100 (USD 100 received)
```

**Key insight:** The EUR account's `quantity` changed by -125 EUR (accounting balance), but its `value` in the transaction currency is -100 USD.

### Correct Usage in Multi-Currency Code

**For balance summation:** Use `quantity` to count what you own in each account's native commodity, then convert to base currency:

```typescript
// Correct: Use quantity for balance, then apply exchange rate
const splitAmount = toDecimal(split.quantity_num, split.quantity_denom);
const exchangeRate = await findExchangeRate(accountCurrency, baseCurrency, date);
const baseAmount = splitAmount * exchangeRate;
```

**NOT this:**

```typescript
// Wrong: value is already transaction-based, not account-based
const splitAmount = toDecimal(split.value_num, split.value_denom);
// Now you're mixing transaction currencies without proper normalization
```

---

## Investment Accounts

Investment accounts hold shares, not currency. The distinction is even more critical:

- **`quantity`**: Number of **shares** held
- **`value`**: **Cost in the transaction currency** (cash paid to acquire shares)

### Example: Buy 50 shares of Apple stock at USD 150/share

```
Transaction (USD currency):
  Description: Buy 50 shares AAPL

  Split 1 (AAPL Stock account):
    value:    7500 (USD 7500 spent)
    quantity: 50 (50 shares bought)

  Split 2 (Cash account - USD):
    value:    -7500 (USD 7500 paid)
    quantity: -7500 (USD 7500 paid)
```

### Calculating Investment Holdings

```typescript
// 1. Get total shares held (quantity)
const shares = calculateShares(splits);  // Uses quantity_num/quantity_denom

// 2. Get cost basis (value, in transaction currency)
const costBasis = calculateCostBasis(splits);  // Uses value_num/value_denom

// 3. Get latest price (from prices table)
const currentPrice = await getLatestPrice(commodityGuid);

// 4. Calculate current market value
const marketValue = shares * currentPrice;

// 5. Calculate gain/loss
const gainLoss = marketValue - costBasis;
```

### Cash Flow Reporting for Investments

```typescript
// Cash flow for investments uses VALUE (cash impact)
// because we care about cash spent/received, not shares
const investmentSplits = await prisma.splits.findMany({
  where: { account_guid: investmentAccountGuid },
  select: { value_num: true, value_denom: true }
});

const totalCashImpact = investmentSplits.reduce((sum, split) =>
  sum + toDecimal(split.value_num, split.value_denom), 0
);
```

---

## Decision Matrix: When to Use Which

| Scenario | Use | Why | Example |
|----------|-----|-----|---------|
| Account balance (cash/bank) | `quantity` | Shows amount you own in account's currency | USD account balance: all USD |
| Account balance (investments) | `quantity` | Shows shares held | Stock account: number of shares |
| Multi-currency balance | `quantity` + exchange rate | Normalize to base currency first | EUR account + EUR→USD rate |
| Investment valuation | `quantity` for shares, `value` for cost | `quantity` = shares, `value` = cash spent | 50 shares costing USD 7500 |
| Transaction display | `value` | Shows amount in transaction currency | Journal entry shows transaction currency |
| Cash flow statement | `quantity` for regular accounts, `value` for investments | Regular: account amounts; Investments: cash impact | Income/expense uses account currency |
| Price lookups | N/A (see `prices` table) | Prices are stored separately | AAPL @ USD 180 on 2025-01-15 |

---

## Code Patterns

### Pattern 1: Simple Balance (Same Currency)

```typescript
const splits = await prisma.splits.findMany({
  where: { account_guid: accountGuid },
  select: { quantity_num: true, quantity_denom: true }
});

const balance = splits.reduce((sum, split) =>
  sum + toDecimal(split.quantity_num, split.quantity_denom), 0
);
```

**File reference:** `src/lib/reports/transaction-report.ts:91`

---

### Pattern 2: Multi-Currency Balance

```typescript
// Fetch splits for non-base-currency accounts
const splits = await prisma.splits.findMany({
  where: { account_guid: { in: accountGuids } },
  select: {
    account_guid: true,
    quantity_num: true,
    quantity_denom: true,
    transaction: { select: { post_date: true } }
  }
});

// Convert to base currency using quantity + exchange rate
for (const split of splits) {
  const amount = toDecimal(split.quantity_num, split.quantity_denom);
  const exchangeRate = await findExchangeRate(
    accountCurrency,
    baseCurrency.guid,
    split.transaction.post_date
  );
  const baseAmount = amount * exchangeRate;
  totalBalance += baseAmount;
}
```

**File reference:** `src/app/api/dashboard/kpis/route.ts:199-206`

---

### Pattern 3: Investment Valuation

```typescript
// Get shares held (quantity)
const shares = calculateShares(investmentSplits);

// Get cost basis (value = cash paid)
const costBasis = calculateCostBasis(investmentSplits);

// Get current price
const latestPrice = await getLatestPrice(commodityGuid, asOfDate);

// Calculate market value
const marketValue = shares * latestPrice;

// Gain/loss
const gainLoss = marketValue - costBasis;
```

**File reference:** `src/lib/commodities.ts:113-149`

---

### Pattern 4: Cash Flow (Distinguishing Account Types)

```typescript
// For regular accounts: use QUANTITY (account currency amount)
// For investment accounts: use VALUE (cash impact)

const splits = await prisma.splits.findMany({
  where: { account_guid: accountGuid },
  select: isInvestment
    ? { value_num: true, value_denom: true }      // Cash impact
    : { quantity_num: true, quantity_denom: true } // Account amount
});

const netChange = splits.reduce((sum, split) => {
  if (isInvestment) {
    return sum + toDecimal(split.value_num, split.value_denom);
  }
  return sum + toDecimal(split.quantity_num, split.quantity_denom);
}, 0);
```

**File reference:** `src/lib/reports/cash-flow.ts:72-101`

---

### Pattern 5: Transaction Report (Display Layer)

```typescript
// Show amount in transaction currency
// For reports viewed by humans, use VALUE
const amount = toDecimal(split.value_num, split.value_denom);

// This is what appears in ledgers and reports
items.push({
  date: tx.post_date,
  description: tx.description,
  amount: amount,  // In transaction currency
  account: accountName
});
```

**File reference:** `src/lib/reports/transaction-report.ts:91`

---

### Pattern 6: Trade Valuation (Showing Cost Basis)

```typescript
// For investment transactions, show the VALUE
// (cost paid in transaction currency)
const costInTransactionCurrency = toDecimal(
  split.value_num,
  split.value_denom
);

transactions.push({
  date: split.transaction.post_date,
  shares: toDecimal(split.quantity_num, split.quantity_denom),
  amount: costInTransactionCurrency  // Cost basis
});
```

**File reference:** `src/app/api/accounts/[guid]/valuation/route.ts:109-110`

---

## Common Mistakes

### ❌ Mistake 1: Using Value for Multi-Currency Balance

```typescript
// WRONG: value is transaction-based, not account-based
const balance = splits.reduce((sum, split) =>
  sum + toDecimal(split.value_num, split.value_denom), 0
);
// If splits are in different transaction currencies,
// you're adding incomparable amounts
```

**Fix:** Use `quantity` instead:
```typescript
const balance = splits.reduce((sum, split) =>
  sum + toDecimal(split.quantity_num, split.quantity_denom), 0
);
```

---

### ❌ Mistake 2: Using Quantity for Investment Cash Flow

```typescript
// WRONG: quantity is share count, not cash impact
const cashImpact = splits.reduce((sum, split) =>
  sum + toDecimal(split.quantity_num, split.quantity_denom), 0
);
// For a buy: quantity = 50 shares, but cash impact = USD 7500
```

**Fix:** Use `value` for investments:
```typescript
const cashImpact = splits.reduce((sum, split) =>
  sum + toDecimal(split.value_num, split.value_denom), 0
);
```

---

### ❌ Mistake 3: Confusing Prices Table with Split Values

The `prices` table stores **historical prices**, separate from splits:

```sql
-- Prices table: commodity quoted in a currency
SELECT * FROM prices
WHERE commodity_guid = 'AAPL_guid'
  AND currency_guid = 'USD_guid'
  AND date = '2025-01-15';
-- Result: AAPL @ USD 180.50

-- NOT the same as split value!
-- Split value = cash spent (e.g., 7500 USD for 50 shares)
-- Price = per-share rate (e.g., 150 USD/share)
```

---

## Summary Table

| Field | Content | Currency | Used For |
|-------|---------|----------|----------|
| `value_num/value_denom` | Transaction amount | Transaction's currency | Display, cash flow, cost basis |
| `quantity_num/quantity_denom` | Account amount | Account's commodity | Balance calculations, share counts |
| `prices.value_num/denom` | Commodity price | Reference currency | Valuation, market value |

---

## Reference Files

### Correctly Using `quantity`
- `src/app/api/dashboard/kpis/route.ts` - KPI net worth using quantity + exchange rates
- `src/app/api/dashboard/net-worth/route.ts` - Net worth calculation
- `src/app/api/dashboard/income-expense/route.ts` - Income/expense in account currency
- `src/app/api/dashboard/sankey/route.ts` - Account flow analysis
- `src/app/api/reports/treasurer/route.ts` - Treasury report

### Correctly Using `value`
- `src/lib/reports/transaction-report.ts:91` - Transaction report (transaction currency)
- `src/lib/reports/cash-flow.ts:89-101` - Cash flow (distinguishes investments)
- `src/app/api/accounts/[guid]/valuation/route.ts:110` - Trade cost display

### Helper Functions
- `src/lib/db.ts:toDecimal()` - Convert fractions to decimal
- `src/lib/commodities.ts:calculateShares()` - Sum quantity field
- `src/lib/commodities.ts:calculateCostBasis()` - Sum value field
- `src/lib/currency.ts:findExchangeRate()` - Get exchange rates for conversion

---

## GnuCash Background

GnuCash represents amounts as fractions (numerator/denominator) for precision. Denominators are typically powers of 10:
- USD: usually denom = 100 (cents)
- EUR: usually denom = 100 (cents)
- Shares: usually denom = 1 (whole shares) or other depending on fractional shares

Use `toDecimal()` to convert fractions to decimal strings for calculations.
