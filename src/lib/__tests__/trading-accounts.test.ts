import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Prisma mock -----------------------------------------------------------

const mockAccountsFindFirst = vi.fn();
const mockAccountsCreate = vi.fn();
const mockCommoditiesFindFirst = vi.fn();

vi.mock('@/lib/prisma', () => ({
  default: {
    accounts: {
      findFirst: (...args: unknown[]) => mockAccountsFindFirst(...args),
      create: (...args: unknown[]) => mockAccountsCreate(...args),
    },
    commodities: {
      findFirst: (...args: unknown[]) => mockCommoditiesFindFirst(...args),
    },
  },
  generateGuid: () => 'test-guid-' + Math.random().toString(36).slice(2),
}));

import {
  getOrCreateTradingAccount,
  generateTradingSplits,
  calculateImbalances,
  type CommodityImbalance,
} from '../trading-accounts';

// --- Helpers ----------------------------------------------------------------

interface FakeAccount {
  guid: string;
  name: string;
  account_type?: string;
  parent_guid?: string | null;
  commodity_guid?: string | null;
}

/**
 * Set up a stateful mock that simulates the database. findFirst returns
 * matching accounts that have been "created"; create stores them.
 */
function setupStatefulMock(seedAccounts: FakeAccount[] = []) {
  const accounts: FakeAccount[] = [...seedAccounts];

  mockAccountsFindFirst.mockImplementation(
    ({ where }: { where: Record<string, unknown> }) => {
      const match = accounts.find(a => {
        if (where.account_type !== undefined && a.account_type !== where.account_type) return false;
        if (where.name !== undefined && a.name !== where.name) return false;
        if (where.parent_guid !== undefined && a.parent_guid !== where.parent_guid) return false;
        return true;
      });
      return Promise.resolve(match ?? null);
    },
  );

  mockAccountsCreate.mockImplementation(
    ({ data }: { data: FakeAccount }) => {
      accounts.push(data);
      return Promise.resolve(data);
    },
  );

  mockCommoditiesFindFirst.mockResolvedValue({ guid: 'usd-commodity-guid' });

  return accounts;
}

// --- Tests ------------------------------------------------------------------

describe('getOrCreateTradingAccount', () => {
  beforeEach(() => {
    mockAccountsFindFirst.mockReset();
    mockAccountsCreate.mockReset();
    mockCommoditiesFindFirst.mockReset();
  });

  it('creates Trading > NYSE > VTI hierarchy for an NYSE-listed security', async () => {
    const accounts = setupStatefulMock([
      { guid: 'root-guid', name: 'Root Account', account_type: 'ROOT' },
    ]);

    await getOrCreateTradingAccount('vti-commodity-guid', 'VTI', 'NYSE');

    const tradingRoot = accounts.find(a => a.name === 'Trading');
    const nyseGroup = accounts.find(a => a.name === 'NYSE');
    const vtiAccount = accounts.find(a => a.name === 'VTI');

    expect(tradingRoot).toBeDefined();
    expect(tradingRoot?.parent_guid).toBe('root-guid');

    expect(nyseGroup).toBeDefined();
    expect(nyseGroup?.parent_guid).toBe(tradingRoot?.guid);

    expect(vtiAccount).toBeDefined();
    expect(vtiAccount?.parent_guid).toBe(nyseGroup?.guid);
    expect(vtiAccount?.commodity_guid).toBe('vti-commodity-guid');

    // Crucially: there should be NO 'CURRENCY' group created for a stock
    expect(accounts.find(a => a.name === 'CURRENCY')).toBeUndefined();
  });

  it('creates Trading > CURRENCY > USD hierarchy for a fiat currency', async () => {
    const accounts = setupStatefulMock([
      { guid: 'root-guid', name: 'Root Account', account_type: 'ROOT' },
    ]);

    await getOrCreateTradingAccount('usd-commodity-guid', 'USD', 'CURRENCY');

    expect(accounts.find(a => a.name === 'CURRENCY')).toBeDefined();
    const usdAccount = accounts.find(a => a.name === 'USD');
    expect(usdAccount).toBeDefined();
    const currencyGroup = accounts.find(a => a.name === 'CURRENCY');
    expect(usdAccount?.parent_guid).toBe(currencyGroup?.guid);
  });

  it('reuses existing Trading > NYSE > VTI when present', async () => {
    setupStatefulMock([
      { guid: 'root-guid', name: 'Root Account', account_type: 'ROOT' },
      { guid: 'trading-guid', name: 'Trading', account_type: 'TRADING', parent_guid: 'root-guid' },
      { guid: 'nyse-guid', name: 'NYSE', account_type: 'TRADING', parent_guid: 'trading-guid' },
      { guid: 'vti-trading-guid', name: 'VTI', account_type: 'TRADING', parent_guid: 'nyse-guid' },
    ]);

    const result = await getOrCreateTradingAccount('vti-commodity-guid', 'VTI', 'NYSE');

    expect(result).toBe('vti-trading-guid');
    expect(mockAccountsCreate).not.toHaveBeenCalled();
  });

  it('keeps NYSE and CURRENCY hierarchies separate (regression for cross-namespace contamination)', async () => {
    const accounts = setupStatefulMock([
      { guid: 'root-guid', name: 'Root Account', account_type: 'ROOT' },
    ]);

    await getOrCreateTradingAccount('usd-guid', 'USD', 'CURRENCY');
    await getOrCreateTradingAccount('vti-guid', 'VTI', 'NYSE');

    const namespaceGroups = accounts.filter(a =>
      a.parent_guid === accounts.find(t => t.name === 'Trading')?.guid,
    );
    const groupNames = namespaceGroups.map(g => g.name).sort();
    expect(groupNames).toEqual(['CURRENCY', 'NYSE']);
  });
});

// ----------------------------------------------------------------------------
// Trading-split generation: VALUE and quantity precision (regression for
// "trading splits show in SHARES column instead of BUY/SELL" bug)
// ----------------------------------------------------------------------------

describe('generateTradingSplits', () => {
  it('writes non-zero VALUE on trading splits so they render in BUY/SELL columns', () => {
    // Simulate a dividend-with-reinvestment: $704.65 dividend → 2.2228 VTI shares.
    // Asset (VTI) split: value=-704.65 (web-app sign convention for buy), quantity=+2.2228 VTI
    // Income (USD) split: value=+704.65, quantity=+704.65 USD
    // Trading splits should negate each commodity's value AND quantity.
    const imbalances: Map<string, CommodityImbalance> = new Map([
      ['vti-guid', {
        mnemonic: 'VTI', namespace: 'NYSE', fraction: 10000,
        valueImbalance: -704.65, quantityImbalance: 2.2228,
      }],
      ['usd-guid', {
        mnemonic: 'USD', namespace: 'CURRENCY', fraction: 100,
        valueImbalance: 704.65, quantityImbalance: 704.65,
      }],
    ]);

    const tradingGuids = new Map([
      ['vti-guid', 'trading-vti-guid'],
      ['usd-guid', 'trading-usd-guid'],
    ]);

    const splits = generateTradingSplits(imbalances, tradingGuids);

    const vtiSplit = splits.find(s => s.accountGuid === 'trading-vti-guid')!;
    const usdSplit = splits.find(s => s.accountGuid === 'trading-usd-guid')!;

    // VTI trading: value should be +704.65 (negation of -704.65), in transaction currency
    expect(vtiSplit.valueNum).toBe(70465);
    expect(vtiSplit.valueDenom).toBe(100);
    // VTI trading: quantity should be -2.2228 with denom matching VTI's fraction (10000)
    expect(vtiSplit.quantityNum).toBe(-22228);
    expect(vtiSplit.quantityDenom).toBe(10000);

    // USD trading: value should be -704.65 (negation of +704.65)
    expect(usdSplit.valueNum).toBe(-70465);
    expect(usdSplit.valueDenom).toBe(100);
    // USD trading: quantity should be -704.65 USD with denom 100
    expect(usdSplit.quantityNum).toBe(-70465);
    expect(usdSplit.quantityDenom).toBe(100);
  });

  it('preserves stock-share precision (regression: 2.2228 was being truncated to 2.22)', () => {
    const imbalances: Map<string, CommodityImbalance> = new Map([
      ['vti-guid', {
        mnemonic: 'VTI', namespace: 'NYSE', fraction: 10000,
        valueImbalance: -704.65, quantityImbalance: 2.2228,
      }],
    ]);
    const tradingGuids = new Map([['vti-guid', 'trading-vti-guid']]);

    const [split] = generateTradingSplits(imbalances, tradingGuids);

    // 2.2228 with denom 10000 → 22228 (full 4-decimal precision retained).
    // The old code used denom=100, giving round(2.2228*100)=222, i.e. 2.22.
    expect(split.quantityNum / split.quantityDenom).toBeCloseTo(-2.2228, 4);
    expect(split.quantityDenom).toBe(10000);
  });

  it('still works for currency-to-currency exchange (USD→EUR)', () => {
    // USD account: value=-100, quantity=-100 USD
    // EUR account: value=+100, quantity=+85 EUR
    const imbalances: Map<string, CommodityImbalance> = new Map([
      ['usd-guid', {
        mnemonic: 'USD', namespace: 'CURRENCY', fraction: 100,
        valueImbalance: -100, quantityImbalance: -100,
      }],
      ['eur-guid', {
        mnemonic: 'EUR', namespace: 'CURRENCY', fraction: 100,
        valueImbalance: 100, quantityImbalance: 85,
      }],
    ]);
    const tradingGuids = new Map([
      ['usd-guid', 'trading-usd-guid'],
      ['eur-guid', 'trading-eur-guid'],
    ]);

    const splits = generateTradingSplits(imbalances, tradingGuids);
    const usdSplit = splits.find(s => s.accountGuid === 'trading-usd-guid')!;
    const eurSplit = splits.find(s => s.accountGuid === 'trading-eur-guid')!;

    // Trading USD: value=+100, quantity=+100 USD (negates the -100 imbalances)
    expect(usdSplit.valueNum).toBe(10000);
    expect(usdSplit.quantityNum).toBe(10000);
    // Trading EUR: value=-100, quantity=-85
    expect(eurSplit.valueNum).toBe(-10000);
    expect(eurSplit.quantityNum).toBe(-8500);
  });
});

describe('calculateImbalances', () => {
  it('sums both quantity AND value imbalances per commodity', () => {
    const imbalances = calculateImbalances([
      {
        accountGuid: 'asset-vti-guid',
        commodityGuid: 'vti-guid', commodityMnemonic: 'VTI',
        commodityNamespace: 'NYSE', commodityFraction: 10000,
        value: -704.65, quantity: 2.2228,
      },
      {
        accountGuid: 'income-guid',
        commodityGuid: 'usd-guid', commodityMnemonic: 'USD',
        commodityNamespace: 'CURRENCY', commodityFraction: 100,
        value: 704.65, quantity: 704.65,
      },
    ]);

    expect(imbalances.get('vti-guid')).toMatchObject({
      quantityImbalance: 2.2228, valueImbalance: -704.65, fraction: 10000,
    });
    expect(imbalances.get('usd-guid')).toMatchObject({
      quantityImbalance: 704.65, valueImbalance: 704.65, fraction: 100,
    });
  });
});
