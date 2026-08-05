/**
 * Tax estimator book aggregation tests.
 *
 * - expandMappingsToDescendants: effective-mapping resolution (inheritance,
 *   explicit child override) — this is the helper the realized-gains sweep
 *   uses to decide whether an investment account is 'exclude'-mapped.
 * - aggregateBookTaxData (mocked Prisma/lots/contribution summary):
 *   realized gains now flow through the PER-SALE extraction shared with the
 *   Form 8949 report (loadRealizedSales -> lotToRealizedSales), so these
 *   tests pin the estimator-critical behaviors:
 *     - per-sale YEAR attribution (a lot sold across years splits its gain),
 *     - open (partially-sold) lots' realized portions included,
 *     - UTC calendar-year bucketing of sale dates,
 *     - per-sale ST/LT via the shared IRS calendar-anniversary isLongTerm,
 *     - retirement + 'exclude'-mapped accounts filtered identically to 8949,
 *     - transferred lots using carried_basis + carried acquisition dates;
 *   plus the pre-existing category-sum and sheltered-guard behavior.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  default: {
    gnucash_web_tax_mappings: { findMany: vi.fn() },
    accounts: { findMany: vi.fn() },
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
  getLotsForAccounts: vi.fn(),
}));

import prisma from '@/lib/prisma';
import { getRetirementAccountGuids } from '@/lib/reports/contribution-classifier';
import { generateContributionSummary } from '@/lib/reports/contribution-summary';
import { getAccountLots, getLotsForAccounts, type LotSummary, type LotSplit } from '@/lib/lots';
import { aggregateBookTaxData, expandMappingsToDescendants } from '@/lib/tax/book-income';
import type { TaxCategory } from '@/lib/tax/types';

const mockPrisma = prisma as unknown as {
  gnucash_web_tax_mappings: { findMany: Mock };
  accounts: { findMany: Mock };
  $queryRaw: Mock;
};
const mockGetRetirementAccountGuids = vi.mocked(getRetirementAccountGuids);
const mockGenerateContributionSummary = vi.mocked(generateContributionSummary);
const mockGetAccountLots = vi.mocked(getAccountLots);
const mockGetLotsForAccounts = vi.mocked(getLotsForAccounts);

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

let splitSeq = 0;
function split(shares: number, value: number, postDate: string): LotSplit {
  splitSeq += 1;
  return {
    guid: `split-${splitSeq}`,
    txGuid: `tx-${splitSeq}`,
    postDate,
    description: '',
    shares,
    value,
    shareBalance: 0,
  };
}

function lot(overrides: Partial<LotSummary>): LotSummary {
  return {
    guid: 'lot-1',
    accountGuid: 'taxable-stock',
    isClosed: true,
    title: 'Lot 1',
    openDate: '2023-02-10T12:00:00.000Z',
    closeDate: `${TAX_YEAR}-06-15T12:00:00.000Z`,
    totalShares: 0,
    totalCost: 1000,
    realizedGain: 0,
    unrealizedGain: null,
    holdingPeriod: 'long_term',
    currentPrice: null,
    sourceLotGuid: null,
    acquisitionDate: null,
    carriedBasis: 0,
    splits: [],
    ...overrides,
  };
}

/** A closed lot: buy `cost` in 2023, sell everything for `proceeds` in TAX_YEAR. */
function simpleClosedLot(overrides: Partial<LotSummary>, cost: number, proceeds: number): LotSummary {
  return lot({
    splits: [
      split(10, cost, '2023-02-10T12:00:00.000Z'),
      split(-10, -proceeds, `${TAX_YEAR}-06-15T12:00:00.000Z`),
    ],
    ...overrides,
  });
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

    // loadRealizedSales (the shared 8949 extraction) queries the accounts
    // table twice: investment accounts (with commodity ticker) and the
    // guid/parent rows used to expand 'exclude' mappings to descendants.
    mockPrisma.accounts.findMany.mockImplementation(
      async (args: { where?: { guid?: { in?: string[] }; account_type?: unknown } }) => {
        const guids = args?.where?.guid?.in ?? [];
        if (args?.where?.account_type) {
          return ACCOUNTS
            .filter(a => guids.includes(a.guid) && (a.account_type === 'STOCK' || a.account_type === 'MUTUAL'))
            .map(a => ({ guid: a.guid, commodity: { mnemonic: a.name } }));
        }
        return ACCOUNTS
          .filter(a => guids.includes(a.guid))
          .map(a => ({ guid: a.guid, parent_guid: a.parent_guid }));
      },
    );

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
        return [simpleClosedLot({ accountGuid: 'taxable-stock' }, 1000, 2000)]; // +1000 LT
      }
      if (guid === 'muni-stock') {
        return [simpleClosedLot({ guid: 'lot-2', accountGuid: 'muni-stock' }, 1000, 1500)]; // +500 LT
      }
      return [];
    });
    mockGetLotsForAccounts.mockImplementation(async (guids: string[]) => {
      const entries = await Promise.all(
        guids.map(async guid => [guid, await mockGetAccountLots(guid)] as const),
      );
      return new Map(entries);
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

  it('filters retirement-flagged accounts out of realized gains (8949 parity)', async () => {
    mockGetRetirementAccountGuids.mockResolvedValue(new Set(['taxable-stock']));
    const result = await run();
    // taxable-stock is sheltered; muni-stock is exclude-mapped → nothing left
    expect(result.realizedGains.shortTerm).toBe(0);
    expect(result.realizedGains.longTerm).toBe(0);
    expect(result.realizedGains.accounts).toHaveLength(0);
    expect(mockGetAccountLots).not.toHaveBeenCalledWith('taxable-stock');
  });

  it('attributes gains per SALE year — a lot sold across years splits its gain', async () => {
    // Buy 100 shares for $1000 in 2023; sell 50 for $1500 in 2024 and the
    // remaining 50 for $2000 in TAX_YEAR (2025). The old per-lot close-year
    // attribution booked the whole $2000 gain in 2025; per-sale attribution
    // books only the 2025 sale: 2000 - 500 basis = 1500.
    mockGetAccountLots.mockImplementation(async (guid: string) => {
      if (guid !== 'taxable-stock') return [];
      return [lot({
        splits: [
          split(100, 1000, '2023-02-10T12:00:00.000Z'),
          split(-50, -1500, '2024-08-01T12:00:00.000Z'),
          split(-50, -2000, `${TAX_YEAR}-03-01T12:00:00.000Z`),
        ],
      })];
    });
    const result = await run();
    expect(result.realizedGains.longTerm).toBe(1500);
    expect(result.realizedGains.shortTerm).toBe(0);
  });

  it('includes the realized portion of a still-OPEN (partially-sold) lot', async () => {
    // Buy 100 for $1000 in Jan TAX_YEAR, sell 40 for $900 in Jun; the lot
    // stays open. Realized: 900 - (40 × $10) = 500, short-term.
    mockGetAccountLots.mockImplementation(async (guid: string) => {
      if (guid !== 'taxable-stock') return [];
      return [lot({
        isClosed: false,
        closeDate: null,
        openDate: `${TAX_YEAR}-01-05T12:00:00.000Z`,
        splits: [
          split(100, 1000, `${TAX_YEAR}-01-05T12:00:00.000Z`),
          split(-40, -900, `${TAX_YEAR}-06-10T12:00:00.000Z`),
        ],
      })];
    });
    const result = await run();
    expect(result.realizedGains.shortTerm).toBe(500);
    expect(result.realizedGains.longTerm).toBe(0);
  });

  it('buckets sale years in UTC, not local time', async () => {
    // A sale at 23:00Z on Dec 31 of TAX_YEAR belongs to TAX_YEAR; a sale at
    // 00:30Z on Jan 1 of the NEXT year does not — even though in any
    // negative-offset (US) local timezone its local date is still Dec 31.
    mockGetAccountLots.mockImplementation(async (guid: string) => {
      if (guid !== 'taxable-stock') return [];
      return [lot({
        splits: [
          split(100, 1000, '2023-02-10T12:00:00.000Z'),
          split(-50, -1600, `${TAX_YEAR}-12-31T23:00:00.000Z`), // in TAX_YEAR: +1100
          split(-50, -2000, `${TAX_YEAR + 1}-01-01T00:30:00.000Z`), // next year: excluded
        ],
      })];
    });
    const result = await run();
    expect(result.realizedGains.longTerm).toBe(1100);
    expect(result.realizedGains.shortTerm).toBe(0);
  });

  it('classifies ST/LT per sale with the IRS calendar-anniversary rule (leap year)', async () => {
    // Acquired 2024-02-01 (leap year): selling on the 2025-02-01 anniversary
    // is 366 elapsed days but NOT "more than one year" → SHORT-term. A naive
    // 365-day millisecond threshold calls it long-term. The next day is LT.
    mockGetAccountLots.mockImplementation(async (guid: string) => {
      if (guid !== 'taxable-stock') return [];
      return [lot({
        openDate: '2024-02-01T12:00:00.000Z',
        splits: [
          split(20, 2000, '2024-02-01T12:00:00.000Z'),
          split(-10, -1500, `${TAX_YEAR}-02-01T12:00:00.000Z`), // anniversary: ST +500
          split(-10, -1800, `${TAX_YEAR}-02-02T12:00:00.000Z`), // day after: LT +800
        ],
      })];
    });
    const result = await run();
    expect(result.realizedGains.shortTerm).toBe(500);
    expect(result.realizedGains.longTerm).toBe(800);
  });

  it('uses carried_basis and the carried acquisition date for transferred lots', async () => {
    // A transfer-destination lot: shares arrived on a $0-value in-kind
    // transfer-in split; the original $800 basis lives in the carried_basis
    // slot and the original 2023 purchase date in acquisition_date. Selling
    // for $1500 in TAX_YEAR realizes 1500 - 800 = 700, LONG-term (measured
    // from the carried 2023 acquisition date, not the transfer date).
    mockGetAccountLots.mockImplementation(async (guid: string) => {
      if (guid !== 'taxable-stock') return [];
      return [lot({
        sourceLotGuid: 'src-lot',
        acquisitionDate: '2023-05-10T12:00:00.000Z',
        carriedBasis: 800,
        openDate: `${TAX_YEAR}-03-01T12:00:00.000Z`,
        splits: [
          split(10, 0, `${TAX_YEAR}-03-01T12:00:00.000Z`),   // $0-value transfer-in
          split(-10, -1500, `${TAX_YEAR}-09-15T12:00:00.000Z`), // real sale
        ],
      })];
    });
    const result = await run();
    expect(result.realizedGains.longTerm).toBe(700);
    expect(result.realizedGains.shortTerm).toBe(0);
  });

  it('ignores transfer-OUT ($0-value) disposals — not taxable events', async () => {
    // A lot closed by an in-kind transfer-out: shares leave on a $0-value
    // split (basis travels to the destination lot). No gain/loss may appear.
    mockGetAccountLots.mockImplementation(async (guid: string) => {
      if (guid !== 'taxable-stock') return [];
      return [lot({
        splits: [
          split(10, 1000, '2023-02-10T12:00:00.000Z'),
          split(-10, 0, `${TAX_YEAR}-04-01T12:00:00.000Z`), // transfer-out
        ],
      })];
    });
    const result = await run();
    expect(result.realizedGains.shortTerm).toBe(0);
    expect(result.realizedGains.longTerm).toBe(0);
    expect(result.realizedGains.accounts).toHaveLength(0);
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
