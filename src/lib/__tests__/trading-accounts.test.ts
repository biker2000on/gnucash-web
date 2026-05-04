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

import { getOrCreateTradingAccount } from '../trading-accounts';

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
