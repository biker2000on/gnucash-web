/**
 * Tax estimator book aggregation tests.
 *
 * - expandMappingsToDescendants: effective-mapping resolution (inheritance,
 *   explicit child override) — this is the helper the realized-gains sweep
 *   uses to decide whether an investment account is 'exclude'-mapped.
 * - aggregateBookTaxData (mocked Prisma/lots/contribution summary):
 *   exclude-mapped investment accounts are skipped from realized gains and
 *   reported via realizedGains.excludedAccountCount; exclude-mapped income
 *   accounts stay out of the category-sum SQL; the new estimated-payment
 *   categories flow through the generic category summing.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  default: {
    gnucash_web_tax_mappings: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));
vi.mock('@/lib/reports/contribution-classifier', () => ({
  getRetirementAccountGuids: vi.fn(),
}));
vi.mock('@/lib/reports/contribution-summary', () => ({
  generateContributionSummary: vi.fn(),
}));
vi.mock('@/lib/lots', () => ({
  getAccountLots: vi.fn(),
}));

import prisma from '@/lib/prisma';
import { getRetirementAccountGuids } from '@/lib/reports/contribution-classifier';
import { generateContributionSummary } from '@/lib/reports/contribution-summary';
import { getAccountLots, type LotSummary } from '@/lib/lots';
import { aggregateBookTaxData, expandMappingsToDescendants } from '@/lib/tax/book-income';
import type { TaxCategory } from '@/lib/tax/types';

const mockPrisma = prisma as unknown as {
  gnucash_web_tax_mappings: { findMany: Mock };
  $queryRaw: Mock;
};
const mockGetRetirementAccountGuids = vi.mocked(getRetirementAccountGuids);
const mockGenerateContributionSummary = vi.mocked(generateContributionSummary);
const mockGetAccountLots = vi.mocked(getAccountLots);

/* ------------------------------------------------------------------ */
/* expandMappingsToDescendants (pure)                                  */
/* ------------------------------------------------------------------ */

describe('expandMappingsToDescendants', () => {
  const accounts = [
    { guid: 'root', parent_guid: null },
    { guid: 'broker', parent_guid: 'root' },
    { guid: 'stock-a', parent_guid: 'broker' },
    { guid: 'stock-b', parent_guid: 'broker' },
    { guid: 'other', parent_guid: 'root' },
  ];

  it('descendants inherit an ancestor exclude mapping', () => {
    const expanded = expandMappingsToDescendants(
      new Map<string, TaxCategory>([['broker', 'exclude']]),
      accounts,
    );
    expect(expanded.get('broker')).toBe('exclude');
    expect(expanded.get('stock-a')).toBe('exclude');
    expect(expanded.get('stock-b')).toBe('exclude');
    expect(expanded.has('other')).toBe(false);
  });

  it('explicit child mapping wins over the inherited one', () => {
    const expanded = expandMappingsToDescendants(
      new Map<string, TaxCategory>([
        ['broker', 'exclude'],
        ['stock-b', 'ordinary_dividends'],
      ]),
      accounts,
    );
    expect(expanded.get('stock-a')).toBe('exclude');
    expect(expanded.get('stock-b')).toBe('ordinary_dividends');
  });
});

/* ------------------------------------------------------------------ */
/* aggregateBookTaxData (mocked I/O)                                   */
/* ------------------------------------------------------------------ */

const TAX_YEAR = 2025;

interface AccountRow {
  guid: string;
  name: string;
  fullname: string;
  account_type: string;
  parent_guid: string | null;
}

const ACCOUNTS: AccountRow[] = [
  { guid: 'broker', name: 'Non-Taxable Brokerage', fullname: 'Assets:Non-Taxable Brokerage', account_type: 'ASSET', parent_guid: null },
  { guid: 'muni-stock', name: 'Muni Fund', fullname: 'Assets:Non-Taxable Brokerage:Muni Fund', account_type: 'MUTUAL', parent_guid: 'broker' },
  { guid: 'taxable-stock', name: 'VTI', fullname: 'Assets:Taxable:VTI', account_type: 'STOCK', parent_guid: null },
  { guid: 'estpay', name: '1040-ES Payments', fullname: 'Expenses:Taxes:1040-ES Payments', account_type: 'EXPENSE', parent_guid: null },
  { guid: 'state-estpay', name: 'State Vouchers', fullname: 'Expenses:Taxes:State Vouchers', account_type: 'EXPENSE', parent_guid: null },
];

function closedLot(overrides: Partial<LotSummary>): LotSummary {
  return {
    guid: 'lot-1',
    accountGuid: 'taxable-stock',
    isClosed: true,
    title: 'Lot 1',
    openDate: '2023-02-10',
    closeDate: `${TAX_YEAR}-06-15`,
    totalShares: 0,
    totalCost: 1000,
    realizedGain: 0,
    unrealizedGain: null,
    holdingPeriod: 'long_term',
    currentPrice: null,
    sourceLotGuid: null,
    acquisitionDate: '2023-02-10',
    splits: [],
    ...overrides,
  };
}

describe('aggregateBookTaxData', () => {
  let splitQueryGuids: string[] | null;

  beforeEach(() => {
    vi.clearAllMocks();
    splitQueryGuids = null;

    mockPrisma.gnucash_web_tax_mappings.findMany.mockResolvedValue([
      { account_guid: 'broker', tax_category: 'exclude' },
      { account_guid: 'estpay', tax_category: 'estimated_tax_payment' },
      { account_guid: 'state-estpay', tax_category: 'state_estimated_tax_payment' },
    ]);

    mockPrisma.$queryRaw.mockImplementation(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        if (sql.includes('FROM account_hierarchy')) return Promise.resolve(ACCOUNTS);
        if (sql.includes('FROM splits')) {
          splitQueryGuids = values[0] as string[];
          return Promise.resolve([
            { account_guid: 'estpay', total: 4000 },
            { account_guid: 'state-estpay', total: 1200 },
          ]);
        }
        return Promise.resolve([]);
      },
    );

    mockGetRetirementAccountGuids.mockResolvedValue(new Set());
    mockGenerateContributionSummary.mockResolvedValue(
      { periods: [] } as unknown as Awaited<ReturnType<typeof generateContributionSummary>>,
    );
    mockGetAccountLots.mockImplementation(async (guid: string) => {
      if (guid === 'taxable-stock') {
        return [closedLot({ accountGuid: 'taxable-stock', realizedGain: 1000 })];
      }
      if (guid === 'muni-stock') {
        return [closedLot({ guid: 'lot-2', accountGuid: 'muni-stock', realizedGain: 500 })];
      }
      return [];
    });
  });

  const run = () =>
    aggregateBookTaxData(ACCOUNTS.map(a => a.guid), TAX_YEAR, null);

  it('skips investment accounts whose effective mapping is exclude (inherited)', async () => {
    const result = await run();

    // muni-stock inherits 'exclude' from broker → its 500 gain is skipped
    expect(result.realizedGains.longTerm).toBe(1000);
    expect(result.realizedGains.shortTerm).toBe(0);
    expect(result.realizedGains.accounts).toHaveLength(1);
    expect(result.realizedGains.accounts[0].accountGuid).toBe('taxable-stock');
    expect(mockGetAccountLots).not.toHaveBeenCalledWith('muni-stock');

    // and the skip is surfaced for the UI
    expect(result.realizedGains.excludedAccountCount).toBe(1);
  });

  it('counts zero excluded accounts when nothing is exclude-mapped', async () => {
    mockPrisma.gnucash_web_tax_mappings.findMany.mockResolvedValue([
      { account_guid: 'estpay', tax_category: 'estimated_tax_payment' },
    ]);
    const result = await run();
    expect(result.realizedGains.excludedAccountCount).toBe(0);
    expect(result.realizedGains.longTerm).toBe(1500); // both accounts feed gains
  });

  it('keeps exclude-mapped accounts out of the category-sum query entirely', async () => {
    await run();
    expect(splitQueryGuids).not.toBeNull();
    expect(splitQueryGuids).not.toContain('broker');
    expect(splitQueryGuids).not.toContain('muni-stock');
    expect(splitQueryGuids).toContain('estpay');
  });

  it('sums the new estimated-payment categories through the generic path', async () => {
    const result = await run();
    const fed = result.categories.find(c => c.category === 'estimated_tax_payment');
    const state = result.categories.find(c => c.category === 'state_estimated_tax_payment');
    expect(fed?.total).toBe(4000);
    expect(state?.total).toBe(1200);
  });
  it('passes sheltered guids (retirement + excluded assets) to the category-sum guard', async () => {
    mockGetRetirementAccountGuids.mockResolvedValue(new Set(['ret-401k']));
    let capturedSql: string | null = null;
    let capturedValues: unknown[] = [];
    mockPrisma.$queryRaw.mockImplementation(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        if (sql.includes('FROM account_hierarchy')) return Promise.resolve(ACCOUNTS);
        if (sql.includes('FROM splits')) {
          capturedSql = sql;
          capturedValues = values;
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      },
    );
    await run();
    // Guard clause present in the SQL
    expect(capturedSql).toContain('NOT EXISTS');
    expect(capturedSql).toContain('s2.account_guid = ANY');
    // The sheltered array carries retirement guids AND exclude-mapped asset
    // accounts (broker + inherited muni-stock), but not income/expense guids
    const arrays = capturedValues.filter((v): v is string[] => Array.isArray(v));
    const sheltered = arrays.find(a => a.includes('ret-401k'));
    expect(sheltered).toBeDefined();
    expect(sheltered).toContain('broker');
    expect(sheltered).toContain('muni-stock');
    expect(sheltered).not.toContain('estpay');
  });
});
