# Work Plan: Investment Dashboard and Auto-Pull Price API

## Context

### Original Request
Build two major investment features:
1. Auto-pull investment prices from a financial API (Financial Modeling Prep recommended)
2. Investment management dashboard with portfolio overview, holdings table, and visualizations

### Research Findings

**Recommended API: Financial Modeling Prep (FMP)**
- 250 API requests/day (free tier)
- Real-time stock prices for stocks, ETFs, mutual funds, forex, crypto
- Well-documented REST API
- Alternative: Finnhub (60 calls/min for more frequent updates)

**FMP Batch Quote Endpoint (Primary):**
```
GET https://financialmodelingprep.com/stable/batch-quote?symbol=AAPL,MSFT,GOOGL&apikey=YOUR_KEY
```

**Response Format:**
```typescript
interface FMPBatchQuoteResponse {
  symbol: string;
  name: string;
  price: number;
  changesPercentage: number;
  change: number;
  dayLow: number;
  dayHigh: number;
  previousClose: number;
  timestamp: number;
}
```

**Single Quote Endpoint (Fallback):**
```
GET https://financialmodelingprep.com/api/v3/quote/{symbol}?apikey=YOUR_KEY
```

### Codebase Context

**Existing Infrastructure:**
- `prices` table: stores prices as fractions (value_num/value_denom)
- `commodities` table: has `mnemonic` (ticker), `quote_flag`, `quote_source` fields
- `src/lib/commodities.ts`: `getLatestPrice()`, `getPriceHistory()`, calculation utilities
- `src/app/api/prices/route.ts`: GET/POST endpoints for prices
- `src/components/InvestmentAccount.tsx`: Reference for charts/cards styling

**Key Utilities:**
- `getCurrencyByMnemonic('USD')` from `@/lib/currency` - looks up currency GUID by mnemonic
- `fromDecimal(value, denom)` from `@/lib/prisma` - converts decimal to GnuCash fraction
- `generateGuid()` from `@/lib/prisma` - generates 32-char hex GUID

**Toast System:**
- `useToast()` from `@/contexts/ToastContext`
- Methods: `success(message)`, `error(message)`, `warning(message)`, `info(message)`

**Navigation:**
- `src/components/Layout.tsx` lines 14-19: `navItems` array for sidebar

**Charting:**
- recharts v3.7.0 installed
- Dark theme styling pattern in `InvestmentAccount.tsx`

---

## Work Objectives

### Core Objective
Create a comprehensive investment management experience with real-time price fetching and portfolio visualization.

### Deliverables
1. API key configuration system (env var + optional settings UI)
2. Price fetching service for Financial Modeling Prep API
3. Manual "Fetch Prices" functionality
4. Investment dashboard page at `/investments`
5. Portfolio overview cards (total value, cost basis, gain/loss)
6. Holdings table with all investment positions
7. Portfolio allocation pie chart (grouped by parent account path)
8. Portfolio performance line chart

### Definition of Done
- [ ] FMP API key can be configured via environment variable
- [ ] Manual price fetch updates prices for all quotable commodities
- [ ] Dashboard displays accurate portfolio totals
- [ ] Holdings table shows all investment accounts with current values
- [ ] Pie chart shows allocation by parent account category
- [ ] Line chart shows portfolio value over time
- [ ] Error handling for API failures (rate limits, invalid symbols)
- [ ] All existing tests pass (if any)
- [ ] No TypeScript errors

---

## Guardrails

### Must Have
- Environment variable for API key (no hardcoded keys)
- Graceful degradation when API unavailable
- Rate limit awareness (250/day for FMP)
- Store fetched prices in existing `prices` table format
- Use `getCurrencyByMnemonic('USD')` for currency GUID lookup
- Match existing dark theme styling
- Responsive design for mobile

### Must NOT Have
- No automatic scheduled fetching (user-triggered only for MVP)
- No paid API tier features
- No modification to GnuCash core schema
- No breaking changes to existing investment account views

---

## Phase 1: Price Fetching Infrastructure

### Task 1.1: Environment Configuration
**File:** `src/lib/config.ts` (new file)

Create configuration module for API keys and settings.

```typescript
// src/lib/config.ts
export const config = {
  fmpApiKey: process.env.FMP_API_KEY || '',
  fmpBaseUrl: 'https://financialmodelingprep.com',
};

export function isFmpConfigured(): boolean {
  return config.fmpApiKey.length > 0;
}
```

**Update:** `.env.local.example`
```
FMP_API_KEY=your_api_key_here
```

**Acceptance Criteria:**
- [ ] Config module exports FMP API key from env
- [ ] `isFmpConfigured()` helper for checking API availability
- [ ] .env.local.example documents the variable

---

### Task 1.2: FMP API Service
**File:** `src/lib/price-service.ts` (new file)

Create service to fetch prices from Financial Modeling Prep using the batch quote endpoint.

**Symbol Mapping Strategy:** Use GnuCash `mnemonic` directly as FMP symbol. GnuCash users typically enter standard ticker symbols (AAPL, MSFT, VTI). If symbol not found on FMP, log warning and skip.

```typescript
// src/lib/price-service.ts
import { config } from './config';

/**
 * FMP Batch Quote Response from /stable/batch-quote endpoint
 */
export interface FMPBatchQuote {
  symbol: string;
  name: string;
  price: number;
  changesPercentage: number;
  change: number;
  dayLow: number;
  dayHigh: number;
  previousClose: number;
  timestamp: number;
}

export interface PriceFetchResult {
  symbol: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  timestamp: Date;
  success: boolean;
  error?: string;
}

export interface QuotableCommodity {
  guid: string;
  mnemonic: string;  // Used directly as FMP symbol
  namespace: string;
  fullname: string | null;
}

/**
 * Fetch batch quotes from FMP using the stable/batch-quote endpoint
 * URL: https://financialmodelingprep.com/stable/batch-quote?symbol=AAPL,MSFT&apikey=KEY
 */
export async function fetchBatchQuotes(symbols: string[]): Promise<PriceFetchResult[]> {
  if (!config.fmpApiKey) {
    return symbols.map(s => ({
      symbol: s,
      price: 0,
      previousClose: 0,
      change: 0,
      changePercent: 0,
      timestamp: new Date(),
      success: false,
      error: 'FMP API key not configured',
    }));
  }

  const symbolList = symbols.join(',');
  const url = `${config.fmpBaseUrl}/stable/batch-quote?symbol=${symbolList}&apikey=${config.fmpApiKey}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`FMP API error: ${response.status} - ${errorText}`);
    }

    const data: FMPBatchQuote[] = await response.json();

    // Map response to results, marking missing symbols as failed
    const resultMap = new Map<string, FMPBatchQuote>();
    for (const quote of data) {
      resultMap.set(quote.symbol.toUpperCase(), quote);
    }

    return symbols.map(symbol => {
      const quote = resultMap.get(symbol.toUpperCase());
      if (!quote) {
        console.warn(`Symbol not found on FMP: ${symbol}`);
        return {
          symbol,
          price: 0,
          previousClose: 0,
          change: 0,
          changePercent: 0,
          timestamp: new Date(),
          success: false,
          error: 'Symbol not found',
        };
      }
      return {
        symbol: quote.symbol,
        price: quote.price,
        previousClose: quote.previousClose,
        change: quote.change,
        changePercent: quote.changesPercentage,
        timestamp: new Date(quote.timestamp * 1000),
        success: true,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return symbols.map(s => ({
      symbol: s,
      price: 0,
      previousClose: 0,
      change: 0,
      changePercent: 0,
      timestamp: new Date(),
      success: false,
      error: message,
    }));
  }
}

/**
 * Get all commodities that should be quoted (quote_flag=1, non-currency)
 */
export async function getQuotableCommodities(): Promise<QuotableCommodity[]> {
  const { default: prisma } = await import('./prisma');

  const commodities = await prisma.commodities.findMany({
    where: {
      quote_flag: 1,
      namespace: { not: 'CURRENCY' },
    },
    select: {
      guid: true,
      mnemonic: true,  // Use directly as FMP symbol
      namespace: true,
      fullname: true,
    },
  });

  return commodities;
}
```

**Acceptance Criteria:**
- [ ] `fetchBatchQuotes()` calls FMP `/stable/batch-quote` endpoint
- [ ] Uses `mnemonic` directly as FMP symbol
- [ ] Missing symbols logged and marked as failed (not thrown)
- [ ] API errors return graceful failure with error message
- [ ] All symbols returned in results (success or failure)

---

### Task 1.3: Price Storage Service
**File:** `src/lib/price-service.ts` (add to existing)

Add functions to store fetched prices in the GnuCash prices table.

**Currency GUID Lookup:** Use existing `getCurrencyByMnemonic('USD')` from `@/lib/currency`.

```typescript
// Add to src/lib/price-service.ts
import { getCurrencyByMnemonic } from '@/lib/currency';
import { fromDecimal, generateGuid } from '@/lib/prisma';

export interface StorePriceResult {
  commodityGuid: string;
  symbol: string;
  success: boolean;
  error?: string;
}

/**
 * Store a fetched price in the GnuCash prices table
 * Uses getCurrencyByMnemonic('USD') for currency_guid lookup
 */
export async function storeFetchedPrice(
  commodityGuid: string,
  symbol: string,
  price: number,
  priceDate: Date = new Date()
): Promise<StorePriceResult> {
  try {
    const { default: prisma } = await import('./prisma');

    // Get USD currency GUID using existing utility
    const usd = await getCurrencyByMnemonic('USD');
    if (!usd) {
      return {
        commodityGuid,
        symbol,
        success: false,
        error: 'USD currency not found in database',
      };
    }

    // Convert price to GnuCash fraction format
    // USD has fraction=100 (2 decimal places)
    const { num, denom } = fromDecimal(price, usd.fraction);

    // Create price entry
    await prisma.prices.create({
      data: {
        guid: generateGuid(),
        commodity_guid: commodityGuid,
        currency_guid: usd.guid,
        date: priceDate,
        value_num: num,
        value_denom: denom,
        source: 'fmp',
        type: 'last',
      },
    });

    return {
      commodityGuid,
      symbol,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      commodityGuid,
      symbol,
      success: false,
      error: message,
    };
  }
}

/**
 * Fetch and store prices for all quotable commodities
 */
export async function fetchAndStorePrices(): Promise<{
  fetched: number;
  stored: number;
  failed: number;
  results: Array<{
    symbol: string;
    price?: number;
    success: boolean;
    error?: string;
  }>;
}> {
  const commodities = await getQuotableCommodities();

  if (commodities.length === 0) {
    return { fetched: 0, stored: 0, failed: 0, results: [] };
  }

  // Build symbol -> commodity map
  const symbolMap = new Map<string, QuotableCommodity>();
  for (const c of commodities) {
    symbolMap.set(c.mnemonic.toUpperCase(), c);
  }

  // Fetch quotes
  const symbols = commodities.map(c => c.mnemonic);
  const quotes = await fetchBatchQuotes(symbols);

  // Store successful quotes
  const results: Array<{ symbol: string; price?: number; success: boolean; error?: string }> = [];
  let stored = 0;
  let failed = 0;

  for (const quote of quotes) {
    if (!quote.success) {
      results.push({ symbol: quote.symbol, success: false, error: quote.error });
      failed++;
      continue;
    }

    const commodity = symbolMap.get(quote.symbol.toUpperCase());
    if (!commodity) {
      results.push({ symbol: quote.symbol, success: false, error: 'Commodity mapping not found' });
      failed++;
      continue;
    }

    const storeResult = await storeFetchedPrice(
      commodity.guid,
      quote.symbol,
      quote.price,
      quote.timestamp
    );

    if (storeResult.success) {
      results.push({ symbol: quote.symbol, price: quote.price, success: true });
      stored++;
    } else {
      results.push({ symbol: quote.symbol, success: false, error: storeResult.error });
      failed++;
    }
  }

  return {
    fetched: quotes.filter(q => q.success).length,
    stored,
    failed,
    results,
  };
}
```

**Acceptance Criteria:**
- [ ] `storeFetchedPrice()` uses `getCurrencyByMnemonic('USD')` for currency GUID
- [ ] Uses `fromDecimal()` with correct fraction (100 for USD)
- [ ] Uses `generateGuid()` for new price GUID
- [ ] Sets source to 'fmp' and type to 'last'
- [ ] `fetchAndStorePrices()` orchestrates full workflow

---

### Task 1.4: Price Fetch API Endpoint
**File:** `src/app/api/prices/fetch/route.ts` (new file)

Create endpoint to trigger price fetching.

```typescript
// src/app/api/prices/fetch/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { fetchAndStorePrices, fetchBatchQuotes, storeFetchedPrice, getQuotableCommodities } from '@/lib/price-service';
import { isFmpConfigured } from '@/lib/config';

// POST /api/prices/fetch
// Body: { symbols?: string[] } - optional, fetches all quotable if not provided
export async function POST(request: NextRequest) {
  try {
    // Check API key configuration
    if (!isFmpConfigured()) {
      return NextResponse.json(
        { error: 'FMP API key not configured. Set FMP_API_KEY environment variable.' },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { symbols } = body as { symbols?: string[] };

    // If specific symbols provided, fetch only those
    if (symbols && symbols.length > 0) {
      const commodities = await getQuotableCommodities();
      const symbolSet = new Set(symbols.map(s => s.toUpperCase()));
      const targetCommodities = commodities.filter(c =>
        symbolSet.has(c.mnemonic.toUpperCase())
      );

      if (targetCommodities.length === 0) {
        return NextResponse.json(
          { error: 'No matching quotable commodities found' },
          { status: 404 }
        );
      }

      const quotes = await fetchBatchQuotes(targetCommodities.map(c => c.mnemonic));
      const results = [];
      let stored = 0;
      let failed = 0;

      for (const quote of quotes) {
        if (!quote.success) {
          results.push({ symbol: quote.symbol, success: false, error: quote.error });
          failed++;
          continue;
        }

        const commodity = targetCommodities.find(
          c => c.mnemonic.toUpperCase() === quote.symbol.toUpperCase()
        );

        if (commodity) {
          const storeResult = await storeFetchedPrice(
            commodity.guid,
            quote.symbol,
            quote.price,
            quote.timestamp
          );
          results.push({
            symbol: quote.symbol,
            price: quote.price,
            success: storeResult.success,
            error: storeResult.error,
          });
          if (storeResult.success) stored++; else failed++;
        }
      }

      return NextResponse.json({
        fetched: quotes.filter(q => q.success).length,
        stored,
        failed,
        results,
      });
    }

    // Fetch all quotable commodities
    const result = await fetchAndStorePrices();
    return NextResponse.json(result);

  } catch (error) {
    console.error('Error fetching prices:', error);
    return NextResponse.json(
      { error: 'Failed to fetch prices' },
      { status: 500 }
    );
  }
}
```

**Response Format:**
```json
{
  "fetched": 5,
  "stored": 4,
  "failed": 1,
  "results": [
    { "symbol": "AAPL", "price": 185.50, "success": true },
    { "symbol": "INVALID", "success": false, "error": "Symbol not found" }
  ]
}
```

**Acceptance Criteria:**
- [ ] Endpoint fetches prices for all quotable commodities
- [ ] Prices stored correctly in `prices` table
- [ ] Returns detailed success/failure per symbol
- [ ] Handles missing API key gracefully (401 response)
- [ ] Supports optional `symbols` array for selective fetch

---

### Task 1.5: Price Fetch Button Integration
**File:** `src/components/InvestmentAccount.tsx` (modify)

Add "Refresh Prices" button to investment account view.

**Location:** Near existing "Add Price" button (lines 310-321)

**Toast Integration:** Use `useToast()` from `@/contexts/ToastContext`

```tsx
import { useToast } from '@/contexts/ToastContext';

// In component:
const { success, error } = useToast();

const [fetchingPrice, setFetchingPrice] = useState(false);

const handleFetchPrice = async () => {
  setFetchingPrice(true);
  try {
    const response = await fetch('/api/prices/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: [commodity.mnemonic] }),
    });

    const data = await response.json();

    if (!response.ok) {
      error(data.error || 'Failed to fetch price');
      return;
    }

    if (data.stored > 0) {
      success(`Price updated: $${data.results[0]?.price?.toFixed(2)}`);
      // Refresh data
      router.refresh();
    } else {
      error(data.results[0]?.error || 'Failed to fetch price');
    }
  } catch (err) {
    error('Network error fetching price');
  } finally {
    setFetchingPrice(false);
  }
};

// In JSX:
<button
  onClick={handleFetchPrice}
  disabled={fetchingPrice}
  className="flex items-center gap-2 px-3 py-2 text-sm bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors disabled:opacity-50"
>
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
  {fetchingPrice ? 'Fetching...' : 'Fetch Price'}
</button>
```

**Acceptance Criteria:**
- [ ] Button visible on investment account pages
- [ ] Clicking fetches latest price for that commodity
- [ ] Loading state shown during fetch
- [ ] Success toast via `useToast().success()`
- [ ] Error toast via `useToast().error()`
- [ ] View refreshes to show new price

---

## Phase 2: Investment Dashboard

### Task 2.1: Add Navigation Item
**File:** `src/components/Layout.tsx` (modify)

Add "Investments" to navigation.

**Location:** Line 14-19, navItems array

```typescript
const navItems = [
    { name: 'Account Hierarchy', href: '/accounts' },
    { name: 'General Ledger', href: '/ledger' },
    { name: 'Investments', href: '/investments' },  // NEW
    { name: 'Budgets', href: '/budgets' },
    { name: 'Reports', href: '/reports' },
];
```

**Acceptance Criteria:**
- [ ] "Investments" appears in sidebar
- [ ] Active state styling works correctly
- [ ] Navigation to /investments works

---

### Task 2.2: Portfolio Data API
**File:** `src/app/api/investments/portfolio/route.ts` (new file)

Create endpoint for aggregated portfolio data.

**Allocation Grouping Strategy:** Group by parent account path (user's folder structure).

```typescript
// src/app/api/investments/portfolio/route.ts
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAccountHoldings } from '@/lib/commodities';

/**
 * Extract allocation category from account path
 * Uses parent folder name for grouping
 *
 * Example: "Assets:Investments:Retirement:401k" -> "Retirement"
 * Example: "Assets:Brokerage:AAPL" -> "Brokerage"
 */
function extractAccountCategory(accountPath: string): string {
  const parts = accountPath.split(':');
  if (parts.length >= 3) {
    // Use second-to-last part (parent folder)
    return parts[parts.length - 2];
  }
  return parts[parts.length - 1] || 'Other';
}

interface PortfolioResponse {
  summary: {
    totalValue: number;
    totalCostBasis: number;
    totalGainLoss: number;
    totalGainLossPercent: number;
    dayChange: number;
    dayChangePercent: number;
  };
  holdings: Array<{
    accountGuid: string;
    accountName: string;
    accountPath: string;
    commodityGuid: string;
    symbol: string;
    fullname: string;
    shares: number;
    costBasis: number;
    marketValue: number;
    gainLoss: number;
    gainLossPercent: number;
    latestPrice: number;
    priceDate: string;
  }>;
  allocation: Array<{
    category: string;
    value: number;
    percent: number;
  }>;
}

export async function GET() {
  try {
    // Get all investment accounts (non-currency commodity accounts)
    const investmentAccounts = await prisma.accounts.findMany({
      where: {
        account_type: 'STOCK',  // or also 'MUTUAL' if needed
        commodity: {
          namespace: { not: 'CURRENCY' },
        },
      },
      include: {
        commodity: true,
        parent: {
          include: {
            parent: true,
          },
        },
      },
    });

    const holdings: PortfolioResponse['holdings'] = [];
    const allocationMap = new Map<string, number>();
    let totalValue = 0;
    let totalCostBasis = 0;
    let dayChange = 0;

    for (const account of investmentAccounts) {
      if (!account.commodity) continue;

      // Use getAccountHoldings which calculates shares, costBasis, marketValue, gainLoss
      const holdingsData = await getAccountHoldings(account.guid);
      if (holdingsData.shares === 0) continue;

      const { shares, costBasis, marketValue, gainLoss, gainLossPercent, latestPrice: latestPriceData } = holdingsData;
      const price = latestPriceData?.value || 0;

      // Build account path
      const pathParts = [account.name];
      let parent = account.parent;
      while (parent) {
        pathParts.unshift(parent.name);
        parent = (parent as { parent?: typeof parent }).parent || null;
      }
      const accountPath = pathParts.join(':');

      holdings.push({
        accountGuid: account.guid,
        accountName: account.name,
        accountPath,
        commodityGuid: account.commodity.guid,
        symbol: account.commodity.mnemonic,
        fullname: account.commodity.fullname || account.commodity.mnemonic,
        shares,
        costBasis,
        marketValue,
        gainLoss,
        gainLossPercent,
        latestPrice: price,
        priceDate: latestPriceData?.date?.toISOString().split('T')[0] || '',
      });

      totalValue += marketValue;
      totalCostBasis += costBasis;

      // Aggregate by category (parent folder)
      const category = extractAccountCategory(accountPath);
      allocationMap.set(category, (allocationMap.get(category) || 0) + marketValue);

      // Note: Day change calculation requires previous close price
      // The current PriceData interface from commodities.ts only has: guid, date, value, source
      // Day change tracking would require storing previous close from FMP API separately
      // For now, dayChange remains 0 (can be enhanced in future iteration)
    }

    const totalGainLoss = totalValue - totalCostBasis;
    const totalGainLossPercent = totalCostBasis !== 0 ? (totalGainLoss / totalCostBasis) * 100 : 0;
    const dayChangePercent = totalValue !== 0 ? (dayChange / (totalValue - dayChange)) * 100 : 0;

    // Build allocation array
    const allocation: PortfolioResponse['allocation'] = [];
    for (const [category, value] of allocationMap) {
      allocation.push({
        category,
        value,
        percent: totalValue !== 0 ? (value / totalValue) * 100 : 0,
      });
    }
    allocation.sort((a, b) => b.value - a.value);

    return NextResponse.json({
      summary: {
        totalValue,
        totalCostBasis,
        totalGainLoss,
        totalGainLossPercent,
        dayChange,
        dayChangePercent,
      },
      holdings,
      allocation,
    } as PortfolioResponse);

  } catch (error) {
    console.error('Error fetching portfolio:', error);
    return NextResponse.json(
      { error: 'Failed to fetch portfolio data' },
      { status: 500 }
    );
  }
}
```

**Acceptance Criteria:**
- [ ] Returns accurate total portfolio value
- [ ] Includes all investment accounts (non-CURRENCY commodities)
- [ ] Holdings include full account path for context
- [ ] Allocation groups by parent account path (using `extractAccountCategory`)
- [ ] Handles accounts with zero shares gracefully

---

### Task 2.3: Portfolio History API
**File:** `src/app/api/investments/history/route.ts` (new file)

Create endpoint for historical portfolio value.

```typescript
// GET /api/investments/history?days=365
// Returns daily portfolio value over time

interface HistoryResponse {
  history: Array<{
    date: string;
    value: number;
  }>;
}
```

**Implementation Notes:**
- For each date, calculate portfolio value using prices available on that date
- If no price on a date, use most recent prior price
- Limit to dates where at least one price exists

**Acceptance Criteria:**
- [ ] Returns portfolio value for each date with price data
- [ ] Handles gaps in price data gracefully
- [ ] Supports configurable date range via `days` param

---

### Task 2.4: Dashboard Page
**File:** `src/app/(main)/investments/page.tsx` (new file)

Create the main investments dashboard page.

**Toast Integration:** Use `useToast()` from `@/contexts/ToastContext`

```tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { formatCurrency } from '@/lib/format';
import { useToast } from '@/contexts/ToastContext';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, LineChart, Line, XAxis, YAxis } from 'recharts';
import { PortfolioSummaryCards } from '@/components/investments/PortfolioSummaryCards';
import { AllocationChart } from '@/components/investments/AllocationChart';
import { PerformanceChart } from '@/components/investments/PerformanceChart';
import { HoldingsTable } from '@/components/investments/HoldingsTable';

export default function InvestmentsPage() {
  const router = useRouter();
  const { success, error, warning } = useToast();

  const [portfolio, setPortfolio] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchingPrices, setFetchingPrices] = useState(false);

  useEffect(() => {
    fetchPortfolio();
    fetchHistory();
  }, []);

  const fetchPortfolio = async () => {
    try {
      const res = await fetch('/api/investments/portfolio');
      const data = await res.json();
      setPortfolio(data);
    } catch (err) {
      error('Failed to load portfolio data');
    } finally {
      setLoading(false);
    }
  };

  const fetchHistory = async () => {
    try {
      const res = await fetch('/api/investments/history?days=365');
      const data = await res.json();
      setHistory(data.history || []);
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  };

  const handleFetchAllPrices = async () => {
    setFetchingPrices(true);
    try {
      const res = await fetch('/api/prices/fetch', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        error(data.error || 'Failed to fetch prices');
        return;
      }

      if (data.stored > 0) {
        success(`Updated ${data.stored} prices`);
        fetchPortfolio(); // Refresh data
      } else if (data.failed > 0) {
        warning(`Failed to fetch ${data.failed} prices`);
      } else {
        warning('No prices to update');
      }
    } catch (err) {
      error('Network error fetching prices');
    } finally {
      setFetchingPrices(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header with Refresh Button */}
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-neutral-100">Investments</h1>
          <p className="text-neutral-500 mt-1">Portfolio overview and performance</p>
        </div>
        <button
          onClick={handleFetchAllPrices}
          disabled={fetchingPrices}
          className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors disabled:opacity-50"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {fetchingPrices ? 'Fetching...' : 'Refresh All Prices'}
        </button>
      </header>

      {/* Summary Cards */}
      {portfolio && (
        <PortfolioSummaryCards
          totalValue={portfolio.summary.totalValue}
          totalCostBasis={portfolio.summary.totalCostBasis}
          totalGainLoss={portfolio.summary.totalGainLoss}
          totalGainLossPercent={portfolio.summary.totalGainLossPercent}
          dayChange={portfolio.summary.dayChange}
          dayChangePercent={portfolio.summary.dayChangePercent}
        />
      )}

      {/* Charts Row */}
      <div className="grid md:grid-cols-2 gap-6">
        {portfolio && <AllocationChart data={portfolio.allocation} />}
        <PerformanceChart data={history} />
      </div>

      {/* Holdings Table */}
      {portfolio && <HoldingsTable holdings={portfolio.holdings} />}
    </div>
  );
}
```

**Acceptance Criteria:**
- [ ] Page renders at /investments
- [ ] Summary cards show portfolio totals
- [ ] Allocation pie chart displays
- [ ] Performance line chart displays
- [ ] Holdings table lists all positions
- [ ] "Refresh All Prices" uses toast notifications

---

### Task 2.5: Portfolio Summary Cards Component
**File:** `src/components/investments/PortfolioSummaryCards.tsx` (new file)

Reusable summary cards component.

```tsx
interface PortfolioSummaryCardsProps {
  totalValue: number;
  totalCostBasis: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  dayChange?: number;
  dayChangePercent?: number;
}

// Card styling matches InvestmentAccount.tsx lines 339-369
```

**Acceptance Criteria:**
- [ ] Displays 4 summary cards in responsive grid
- [ ] Green/red coloring for gain/loss values
- [ ] Matches existing card styling

---

### Task 2.6: Allocation Pie Chart Component
**File:** `src/components/investments/AllocationChart.tsx` (new file)

Portfolio allocation visualization grouped by parent account category.

```tsx
interface AllocationChartProps {
  data: Array<{
    category: string;  // Parent account folder name
    value: number;
    percent: number;
  }>;
}

// Use recharts PieChart with dark theme
// Color palette: cyan, emerald, purple, amber, rose, blue
```

**Acceptance Criteria:**
- [ ] Pie chart renders with proper colors
- [ ] Tooltip shows category name and percentage
- [ ] Legend displays all categories
- [ ] Dark theme styling

---

### Task 2.7: Performance Line Chart Component
**File:** `src/components/investments/PerformanceChart.tsx` (new file)

Historical portfolio value chart.

```tsx
interface PerformanceChartProps {
  data: Array<{
    date: string;
    value: number;
  }>;
}

// Use recharts LineChart matching InvestmentAccount.tsx styling
// Include period selector (1M, 3M, 6M, 1Y, ALL)
```

**Acceptance Criteria:**
- [ ] Line chart displays portfolio value over time
- [ ] Period selector filters displayed range
- [ ] Matches InvestmentAccount.tsx chart styling
- [ ] Tooltip shows date and value

---

### Task 2.8: Holdings Table Component
**File:** `src/components/investments/HoldingsTable.tsx` (new file)

Interactive holdings table.

```tsx
interface HoldingsTableProps {
  holdings: Array<{
    accountGuid: string;
    accountName: string;
    symbol: string;
    shares: number;
    costBasis: number;
    marketValue: number;
    gainLoss: number;
    gainLossPercent: number;
  }>;
}

// Sortable columns: Symbol, Shares, Cost, Value, Gain/Loss, Gain %
// Click row to navigate to account page
```

**Acceptance Criteria:**
- [ ] Table displays all holdings
- [ ] Columns sortable by clicking header
- [ ] Row click navigates to /accounts/[guid]
- [ ] Gain/loss colored green/red
- [ ] Responsive design (horizontal scroll on mobile)

---

## Phase 3: Polish and Error Handling

### Task 3.1: API Key Validation
**File:** `src/app/api/investments/status/route.ts` (new file)

Endpoint to check API configuration status.

```typescript
// GET /api/investments/status
// Returns: { configured: boolean, lastFetch?: string, dailyQuota?: number, quotaUsed?: number }
```

**Acceptance Criteria:**
- [ ] Returns whether API key is configured
- [ ] Dashboard shows warning if API not configured

---

### Task 3.2: Error States and Loading
**Files:** All new components

Add proper error and loading states.

- Loading: Skeleton loaders matching dark theme
- Error: Error message with retry button
- Empty: Friendly message when no investments

**Acceptance Criteria:**
- [ ] Loading skeletons display during fetch
- [ ] Error messages are user-friendly
- [ ] Empty state guides user

---

### Task 3.3: Toast Notifications Integration
**File:** All components that trigger async operations

Ensure consistent toast usage via `@/contexts/ToastContext`.

```typescript
import { useToast } from '@/contexts/ToastContext';

const { success, error, warning, info } = useToast();

// Usage:
success('Prices updated successfully');
error('Failed to fetch prices: ' + errorMessage);
warning('Some prices could not be updated');
info('Refreshing portfolio data...');
```

**Acceptance Criteria:**
- [ ] All price fetch operations show toast
- [ ] Success toast on price fetch
- [ ] Error toast with message on failure
- [ ] Toast auto-dismisses (5s success, 8s error)

---

## Commit Strategy

### Commit 1: Phase 1 - Price Service Foundation
- `src/lib/config.ts`
- `src/lib/price-service.ts`
- `.env.local.example` update

### Commit 2: Phase 1 - Price Fetch API
- `src/app/api/prices/fetch/route.ts`

### Commit 3: Phase 1 - UI Integration
- `src/components/InvestmentAccount.tsx` modifications

### Commit 4: Phase 2 - Dashboard Foundation
- `src/components/Layout.tsx` nav update
- `src/app/(main)/investments/page.tsx`
- `src/app/api/investments/portfolio/route.ts`

### Commit 5: Phase 2 - Charts
- `src/components/investments/AllocationChart.tsx`
- `src/components/investments/PerformanceChart.tsx`
- `src/app/api/investments/history/route.ts`

### Commit 6: Phase 2 - Holdings Table
- `src/components/investments/HoldingsTable.tsx`
- `src/components/investments/PortfolioSummaryCards.tsx`

### Commit 7: Phase 3 - Polish
- Error handling
- Loading states
- Status endpoint

---

## Risk Assessment

### High Risk
| Risk | Mitigation |
|------|------------|
| FMP API changes or rate limits | Abstract behind service layer, easy to swap providers |
| Incorrect price calculations | Reuse existing `fromDecimal`/`toDecimal` utilities |

### Medium Risk
| Risk | Mitigation |
|------|------------|
| Symbol mismatch (GnuCash vs FMP) | Log warnings, skip failures, use mnemonic directly |
| Performance with many holdings | Paginate holdings, cache portfolio totals |

### Low Risk
| Risk | Mitigation |
|------|------------|
| Chart rendering issues | recharts already proven in InvestmentAccount.tsx |
| Navigation conflicts | Simple addition to existing navItems array |

---

## File Summary

### New Files (12)
1. `src/lib/config.ts`
2. `src/lib/price-service.ts`
3. `src/app/api/prices/fetch/route.ts`
4. `src/app/api/investments/portfolio/route.ts`
5. `src/app/api/investments/history/route.ts`
6. `src/app/api/investments/status/route.ts`
7. `src/app/(main)/investments/page.tsx`
8. `src/components/investments/PortfolioSummaryCards.tsx`
9. `src/components/investments/AllocationChart.tsx`
10. `src/components/investments/PerformanceChart.tsx`
11. `src/components/investments/HoldingsTable.tsx`

### Modified Files (3)
1. `src/components/Layout.tsx` - Add navigation item
2. `src/components/InvestmentAccount.tsx` - Add fetch price button with toast
3. `.env.local.example` - Document FMP_API_KEY

---

## Technical Reference

### FMP Batch Quote Endpoint
```
GET https://financialmodelingprep.com/stable/batch-quote?symbol=AAPL,MSFT,GOOGL&apikey=YOUR_KEY
```

Response:
```json
[
  {
    "symbol": "AAPL",
    "name": "Apple Inc.",
    "price": 185.50,
    "changesPercentage": 1.25,
    "change": 2.30,
    "dayLow": 183.00,
    "dayHigh": 186.50,
    "previousClose": 183.20,
    "timestamp": 1706817600
  }
]
```

### Symbol Mapping
- **Strategy:** Use `commodities.mnemonic` directly as FMP symbol
- **Rationale:** GnuCash users typically enter standard ticker symbols
- **Error handling:** Log warning and skip if symbol not found on FMP

### Currency GUID Lookup
```typescript
import { getCurrencyByMnemonic } from '@/lib/currency';

const usd = await getCurrencyByMnemonic('USD');
// Returns: { guid: string, mnemonic: 'USD', fullname: string, fraction: 100 }
```

### Price Storage
```typescript
import { fromDecimal, generateGuid } from '@/lib/prisma';

const { num, denom } = fromDecimal(price, usd.fraction);
await prisma.prices.create({
  data: {
    guid: generateGuid(),
    commodity_guid: commodityGuid,
    currency_guid: usd.guid,
    date: new Date(),
    value_num: num,
    value_denom: denom,
    source: 'fmp',
    type: 'last',
  },
});
```

### Toast System
```typescript
import { useToast } from '@/contexts/ToastContext';

const { success, error, warning, info } = useToast();
success('Prices updated');  // 5s auto-dismiss
error('Failed to fetch');   // 8s auto-dismiss
```

### Allocation Grouping
```typescript
function extractAccountCategory(accountPath: string): string {
  const parts = accountPath.split(':');
  if (parts.length >= 3) {
    return parts[parts.length - 2]; // Parent folder
  }
  return parts[parts.length - 1] || 'Other';
}

// Examples:
// "Assets:Investments:Retirement:401k" -> "Retirement"
// "Assets:Brokerage:AAPL" -> "Brokerage"
```

---

## Success Criteria

### Functional
- [ ] User can configure FMP API key via environment variable
- [ ] User can manually fetch prices for all investments
- [ ] Dashboard shows accurate portfolio summary
- [ ] Holdings table lists all investment positions
- [ ] Allocation chart shows portfolio breakdown by parent account category
- [ ] Performance chart shows value over time

### Non-Functional
- [ ] Page loads in under 2 seconds
- [ ] Charts render smoothly
- [ ] Responsive on mobile devices
- [ ] Graceful handling of API errors

### Quality
- [ ] No TypeScript errors
- [ ] Consistent styling with existing app
- [ ] Proper error boundaries
- [ ] Toast notifications for all user actions
