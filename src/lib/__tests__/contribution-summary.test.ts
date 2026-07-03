import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Prisma mock -----------------------------------------------------------

const mockAccountsFindMany = vi.fn();
const mockAccountPreferencesFindMany = vi.fn();
const mockTaxYearFindMany = vi.fn();
const mockContributionLimitsFindFirst = vi.fn();
const mockTaxMappingsFindMany = vi.fn();
const mockQueryRaw = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    accounts: {
      findMany: (...args: unknown[]) => mockAccountsFindMany(...args),
    },
    gnucash_web_account_preferences: {
      findMany: (...args: unknown[]) => mockAccountPreferencesFindMany(...args),
    },
    gnucash_web_contribution_tax_year: {
      findMany: (...args: unknown[]) => mockTaxYearFindMany(...args),
    },
    gnucash_web_contribution_limits: {
      findFirst: (...args: unknown[]) => mockContributionLimitsFindFirst(...args),
    },
    gnucash_web_tax_mappings: {
      findMany: (...args: unknown[]) => mockTaxMappingsFindMany(...args),
    },
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
  },
}));

import { generateContributionSummary } from '../reports/contribution-summary';
import { ReportType } from '../reports/types';
import type { ReportFilters } from '../reports/types';

// --- Helpers ----------------------------------------------------------------

function makeSplitRow(overrides: Record<string, unknown> = {}) {
  return {
    split_guid: 'split-1',
    account_guid: 'acct-401k',
    value_num: 650000n,
    value_denom: 100n,
    quantity_num: 650000n,
    quantity_denom: 100n,
    post_date: new Date('2025-03-15'),
    description: 'Payroll contribution',
    other_split_guid: 'split-2',
    other_account_guid: 'acct-checking',
    other_value_num: -650000n,
    other_value_denom: 100n,
    other_quantity_num: -650000n,
    other_quantity_denom: 100n,
    other_account_type: 'BANK',
    other_account_name: 'Checking Account',
    other_commodity_guid: 'usd-guid',
    ...overrides,
  };
}

function baseFilters(overrides: Partial<ReportFilters> = {}): ReportFilters {
  return {
    startDate: '2025-01-01',
    endDate: '2025-12-31',
    bookAccountGuids: ['acct-401k', 'acct-checking', 'root'],
    ...overrides,
  };
}

/** Wire up the standard prisma mock chain that getRetirementAccountGuids uses */
function setupRetirementMocks(
  retirementPrefs: Array<{ account_guid: string; is_retirement: boolean; retirement_account_type?: string | null }>,
  allAccounts: Array<{ guid: string; parent_guid: string | null }>,
) {
  // getRetirementAccountGuids calls:
  //   1. gnucash_web_account_preferences.findMany  (with is_retirement: true)
  //   2. accounts.findMany                         (with guid in bookAccountGuids)
  mockAccountPreferencesFindMany.mockImplementation((args: Record<string, unknown>) => {
    const where = (args as { where?: Record<string, unknown> }).where ?? {};
    // The first call is from getRetirementAccountGuids (is_retirement: true filter)
    // The second call is from step 6 (also is_retirement: true, but with select)
    if ((where as Record<string, unknown>).is_retirement === true) {
      return Promise.resolve(retirementPrefs);
    }
    return Promise.resolve([]);
  });

  mockAccountsFindMany.mockImplementation((args: Record<string, unknown>) => {
    const select = (args as { select?: Record<string, unknown> }).select ?? {};
    // accounts.findMany is called multiple times:
    //   - getRetirementAccountGuids: select { guid, parent_guid }
    //   - step 6 (parent map): select { guid, parent_guid }
    //   - step 7 (account names): select { guid, name }
    if (select && (select as Record<string, unknown>).name) {
      return Promise.resolve(allAccounts.map(a => ({ guid: a.guid, name: `Account ${a.guid}` })));
    }
    return Promise.resolve(allAccounts);
  });
}

// --- Tests ------------------------------------------------------------------

describe('generateContributionSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no tax year overrides, no IRS limit overrides, no tax mappings
    mockTaxYearFindMany.mockResolvedValue([]);
    mockContributionLimitsFindFirst.mockResolvedValue(null);
    mockTaxMappingsFindMany.mockResolvedValue([]);
  });

  // ---- 1. Empty cases ----

  it('should return empty report when bookAccountGuids is empty', async () => {
    const result = await generateContributionSummary(
      baseFilters({ bookAccountGuids: [] }),
      'calendar_year',
      null,
    );

    expect(result.type).toBe(ReportType.CONTRIBUTION_SUMMARY);
    expect(result.periods).toEqual([]);
    expect(result.grandTotalContributions).toBe(0);
    expect(result.grandTotalEmployerMatch).toBe(0);
    expect(result.grandTotalNetContributions).toBe(0);
  });

  it('should return empty report when no retirement accounts exist', async () => {
    setupRetirementMocks([], [
      { guid: 'acct-checking', parent_guid: 'root' },
    ]);
    mockQueryRaw.mockResolvedValue([]);

    const result = await generateContributionSummary(
      baseFilters(),
      'calendar_year',
      null,
    );

    expect(result.periods).toEqual([]);
    expect(result.grandTotalContributions).toBe(0);
  });

  // ---- 2. Classification aggregation ----

  it('should aggregate contributions, employer match, and transfers correctly', async () => {
    setupRetirementMocks(
      [{ account_guid: 'acct-401k', is_retirement: true, retirement_account_type: '401k' }],
      [
        { guid: 'acct-401k', parent_guid: 'root' },
        { guid: 'acct-checking', parent_guid: 'root' },
        { guid: 'root', parent_guid: null },
      ],
    );

    // Three split rows: contribution ($6500), employer match ($3250), transfer ($1000)
    mockQueryRaw.mockImplementation(() => {
      // First call: batch split query; second call: account_hierarchy paths
      if (mockQueryRaw.mock.calls.length <= 1) {
        return Promise.resolve([
          // Contribution from bank
          makeSplitRow(),
          // Employer match from income account
          makeSplitRow({
            split_guid: 'split-em',
            value_num: 325000n,
            value_denom: 100n,
            quantity_num: 325000n,
            quantity_denom: 100n,
            other_split_guid: 'split-em-other',
            other_account_guid: 'acct-income-match',
            other_value_num: -325000n,
            other_value_denom: 100n,
            other_quantity_num: -325000n,
            other_quantity_denom: 100n,
            other_account_type: 'INCOME',
            other_account_name: 'Employer Match',
            other_commodity_guid: 'usd-guid',
            description: 'Employer match',
          }),
          // Transfer from another retirement account
          makeSplitRow({
            split_guid: 'split-xfer',
            value_num: 100000n,
            value_denom: 100n,
            quantity_num: 100000n,
            quantity_denom: 100n,
            other_split_guid: 'split-xfer-other',
            other_account_guid: 'acct-old-401k',
            other_value_num: -100000n,
            other_value_denom: 100n,
            other_quantity_num: -100000n,
            other_quantity_denom: 100n,
            other_account_type: 'ASSET',
            other_account_name: 'Old 401k',
            other_commodity_guid: 'usd-guid',
          }),
        ]);
      }
      // account_hierarchy query
      return Promise.resolve([{ guid: 'acct-401k', fullname: 'Assets:Retirement:401k' }]);
    });

    // Make the transfer source a retirement account too
    mockAccountPreferencesFindMany.mockImplementation(() =>
      Promise.resolve([
        { account_guid: 'acct-401k', is_retirement: true, retirement_account_type: '401k' },
        { account_guid: 'acct-old-401k', is_retirement: true, retirement_account_type: '401k' },
      ]),
    );

    mockAccountsFindMany.mockImplementation((args: Record<string, unknown>) => {
      const select = (args as { select?: Record<string, unknown> }).select ?? {};
      if (select && (select as Record<string, unknown>).name) {
        return Promise.resolve([{ guid: 'acct-401k', name: '401k' }]);
      }
      return Promise.resolve([
        { guid: 'acct-401k', parent_guid: 'root' },
        { guid: 'acct-old-401k', parent_guid: 'root' },
        { guid: 'acct-checking', parent_guid: 'root' },
        { guid: 'root', parent_guid: null },
      ]);
    });

    const result = await generateContributionSummary(
      baseFilters({ bookAccountGuids: ['acct-401k', 'acct-old-401k', 'acct-checking', 'root'] }),
      'calendar_year',
      null,
    );

    expect(result.periods.length).toBe(1);
    const period = result.periods[0];
    expect(period.year).toBe(2025);
    expect(period.accounts.length).toBe(1);

    const acct = period.accounts[0];
    expect(acct.contributions).toBe(6500);    // $6500 from bank
    expect(acct.employerMatch).toBe(3250);     // $3250 employer match
    expect(acct.transfers).toBe(1000);         // $1000 transfer

    // Net excludes transfers/rollovers: 6500 + 3250, NOT + 1000
    expect(acct.netContributions).toBe(9750);
    expect(period.totalNetContributions).toBe(9750);
    expect(period.totalTransfers).toBe(1000);
    expect(result.grandTotalTransfers).toBe(1000);
  });

  it('should pass an inclusive end-of-day UTC end date to the split query', async () => {
    setupRetirementMocks(
      [{ account_guid: 'acct-401k', is_retirement: true, retirement_account_type: '401k' }],
      [
        { guid: 'acct-401k', parent_guid: 'root' },
        { guid: 'acct-checking', parent_guid: 'root' },
        { guid: 'root', parent_guid: null },
      ],
    );

    mockQueryRaw.mockImplementation(() => {
      if (mockQueryRaw.mock.calls.length <= 1) {
        // A contribution posted late on the end date (post_dates are 05:59-10:59Z)
        return Promise.resolve([
          makeSplitRow({ post_date: new Date('2025-12-31T10:59:00Z') }),
        ]);
      }
      return Promise.resolve([{ guid: 'acct-401k', fullname: 'Assets:Retirement:401k' }]);
    });

    const result = await generateContributionSummary(
      baseFilters({ startDate: '2025-01-01', endDate: '2025-12-31' }),
      'calendar_year',
      null,
    );

    // $queryRaw is a tagged template: (strings, guidArray, startDate, endDate)
    const splitQueryArgs = mockQueryRaw.mock.calls[0];
    const endDateParam = splitQueryArgs[3] as Date;
    expect(endDateParam.toISOString()).toBe('2025-12-31T23:59:59.000Z');

    // The end-date transaction is included
    expect(result.periods.length).toBe(1);
    expect(result.periods[0].accounts[0].contributions).toBe(6500);
  });

  it('should bucket years by UTC, not local time', async () => {
    setupRetirementMocks(
      [{ account_guid: 'acct-401k', is_retirement: true, retirement_account_type: '401k' }],
      [
        { guid: 'acct-401k', parent_guid: 'root' },
        { guid: 'acct-checking', parent_guid: 'root' },
        { guid: 'root', parent_guid: null },
      ],
    );

    // Jan 1 2026 05:59 UTC is still Dec 31 2025 in US timezones —
    // getFullYear() would misbucket this into 2025.
    mockQueryRaw.mockImplementation(() => {
      if (mockQueryRaw.mock.calls.length <= 1) {
        return Promise.resolve([
          makeSplitRow({ post_date: new Date('2026-01-01T05:59:00Z') }),
        ]);
      }
      return Promise.resolve([{ guid: 'acct-401k', fullname: 'Assets:Retirement:401k' }]);
    });

    const result = await generateContributionSummary(
      baseFilters({ startDate: '2025-01-01', endDate: '2026-12-31' }),
      'calendar_year',
      null,
    );

    expect(result.periods.length).toBe(1);
    expect(result.periods[0].year).toBe(2026);
  });

  it('should classify money leaving to an EXPENSE account as a fee, excluded from net', async () => {
    setupRetirementMocks(
      [{ account_guid: 'acct-401k', is_retirement: true, retirement_account_type: '401k' }],
      [
        { guid: 'acct-401k', parent_guid: 'root' },
        { guid: 'acct-checking', parent_guid: 'root' },
        { guid: 'root', parent_guid: null },
      ],
    );

    mockQueryRaw.mockImplementation(() => {
      if (mockQueryRaw.mock.calls.length <= 1) {
        return Promise.resolve([
          // Regular $6500 contribution
          makeSplitRow(),
          // $50 recordkeeping fee leaving the account to an EXPENSE account
          makeSplitRow({
            split_guid: 'split-fee',
            value_num: -5000n,
            value_denom: 100n,
            quantity_num: -5000n,
            quantity_denom: 100n,
            other_split_guid: 'split-fee-other',
            other_account_guid: 'acct-expense-fees',
            other_value_num: 5000n,
            other_value_denom: 100n,
            other_quantity_num: 5000n,
            other_quantity_denom: 100n,
            other_account_type: 'EXPENSE',
            other_account_name: 'Recordkeeping Fees',
            description: 'Quarterly recordkeeping fee',
          }),
        ]);
      }
      return Promise.resolve([{ guid: 'acct-401k', fullname: 'Assets:Retirement:401k' }]);
    });

    const result = await generateContributionSummary(
      baseFilters(),
      'calendar_year',
      null,
    );

    const acct = result.periods[0].accounts[0];
    expect(acct.fees).toBe(-50);
    expect(acct.withdrawals).toBe(0); // NOT a withdrawal
    // Net excludes fees: 6500, not 6450
    expect(acct.netContributions).toBe(6500);
  });

  it('should always classify sources mapped to employer_match as EMPLOYER_MATCH (descendants included)', async () => {
    setupRetirementMocks(
      [{ account_guid: 'acct-401k', is_retirement: true, retirement_account_type: '401k' }],
      [
        { guid: 'acct-401k', parent_guid: 'root' },
        { guid: 'acct-income-parent', parent_guid: 'root' },
        { guid: 'acct-income-salary', parent_guid: 'acct-income-parent' },
        { guid: 'root', parent_guid: null },
      ],
    );

    // The parent income account is mapped to 'employer_match'; the actual
    // source is its CHILD account named 'Salary' (no match/employer keywords).
    mockTaxMappingsFindMany.mockResolvedValue([
      { account_guid: 'acct-income-parent' },
    ]);

    mockQueryRaw.mockImplementation(() => {
      if (mockQueryRaw.mock.calls.length <= 1) {
        return Promise.resolve([
          makeSplitRow({
            split_guid: 'split-match',
            value_num: 325000n,
            value_denom: 100n,
            quantity_num: 325000n,
            quantity_denom: 100n,
            other_split_guid: 'split-match-other',
            other_account_guid: 'acct-income-salary',
            other_value_num: -325000n,
            other_value_denom: 100n,
            other_quantity_num: -325000n,
            other_quantity_denom: 100n,
            other_account_type: 'INCOME',
            other_account_name: 'Salary',
            description: 'Payroll deposit',
          }),
        ]);
      }
      return Promise.resolve([{ guid: 'acct-401k', fullname: 'Assets:Retirement:401k' }]);
    });

    const result = await generateContributionSummary(
      baseFilters({
        bookAccountGuids: ['acct-401k', 'acct-income-parent', 'acct-income-salary', 'acct-checking', 'root'],
      }),
      'calendar_year',
      null,
    );

    const acct = result.periods[0].accounts[0];
    expect(acct.employerMatch).toBe(3250);
    expect(acct.incomeContributions).toBe(0);
    // Employer match must NOT count toward the IRS limit
    expect(acct.irsLimit).not.toBeNull();
    expect(acct.irsLimit!.percentUsed).toBe(0);
  });

  it('should build a per-account-type rollup with limits where applicable', async () => {
    mockAccountPreferencesFindMany.mockResolvedValue([
      { account_guid: 'acct-401k', is_retirement: true, retirement_account_type: '401k' },
      { account_guid: 'acct-roth', is_retirement: true, retirement_account_type: 'roth_ira' },
    ]);

    mockAccountsFindMany.mockImplementation((args: Record<string, unknown>) => {
      const select = (args as { select?: Record<string, unknown> }).select ?? {};
      if (select && (select as Record<string, unknown>).name) {
        return Promise.resolve([
          { guid: 'acct-401k', name: '401k' },
          { guid: 'acct-roth', name: 'Roth IRA' },
        ]);
      }
      return Promise.resolve([
        { guid: 'acct-401k', parent_guid: 'root' },
        { guid: 'acct-roth', parent_guid: 'root' },
        { guid: 'acct-checking', parent_guid: 'root' },
        { guid: 'root', parent_guid: null },
      ]);
    });

    mockQueryRaw.mockImplementation(() => {
      if (mockQueryRaw.mock.calls.length <= 1) {
        return Promise.resolve([
          // 401k: $5000 direct contribution
          makeSplitRow({
            split_guid: 'split-401k',
            account_guid: 'acct-401k',
            value_num: 500000n, value_denom: 100n,
            quantity_num: 500000n, quantity_denom: 100n,
            other_value_num: -500000n, other_value_denom: 100n,
            other_quantity_num: -500000n, other_quantity_denom: 100n,
          }),
          // 401k: $2350 payroll deferral (income contribution)
          makeSplitRow({
            split_guid: 'split-401k-payroll',
            account_guid: 'acct-401k',
            value_num: 235000n, value_denom: 100n,
            quantity_num: 235000n, quantity_denom: 100n,
            other_split_guid: 'split-payroll-other',
            other_account_guid: 'acct-income-salary',
            other_value_num: -235000n, other_value_denom: 100n,
            other_quantity_num: -235000n, other_quantity_denom: 100n,
            other_account_type: 'INCOME',
            other_account_name: 'Salary',
          }),
          // Roth IRA: $3000 contribution
          makeSplitRow({
            split_guid: 'split-roth',
            account_guid: 'acct-roth',
            value_num: 300000n, value_denom: 100n,
            quantity_num: 300000n, quantity_denom: 100n,
            other_value_num: -300000n, other_value_denom: 100n,
            other_quantity_num: -300000n, other_quantity_denom: 100n,
          }),
        ]);
      }
      return Promise.resolve([
        { guid: 'acct-401k', fullname: 'Assets:Retirement:401k' },
        { guid: 'acct-roth', fullname: 'Assets:Retirement:Roth IRA' },
      ]);
    });

    const result = await generateContributionSummary(
      baseFilters({ bookAccountGuids: ['acct-401k', 'acct-roth', 'acct-checking', 'root'] }),
      'calendar_year',
      null,
    );

    const period = result.periods[0];
    expect(Object.keys(period.byAccountType).sort()).toEqual(['401k', 'roth_ira']);

    const k401 = period.byAccountType['401k'];
    expect(k401.contributions).toBe(5000);
    expect(k401.incomeContributions).toBe(2350);
    expect(k401.net).toBe(7350);
    // 2025 401k limit: 23500; employee deferrals 7350 => ~31.28%
    expect(k401.irsLimit).not.toBeNull();
    expect(k401.irsLimit!.total).toBe(23500);
    expect(k401.irsLimit!.percentUsed).toBeCloseTo((7350 / 23500) * 100, 1);

    const roth = period.byAccountType['roth_ira'];
    expect(roth.contributions).toBe(3000);
    expect(roth.net).toBe(3000);
    expect(roth.irsLimit).not.toBeNull();
    expect(roth.irsLimit!.total).toBe(7000);
  });

  // ---- 3. Tax year grouping vs calendar year grouping ----

  it('should group by tax year when overrides exist', async () => {
    setupRetirementMocks(
      [{ account_guid: 'acct-401k', is_retirement: true, retirement_account_type: '401k' }],
      [
        { guid: 'acct-401k', parent_guid: 'root' },
        { guid: 'acct-checking', parent_guid: 'root' },
        { guid: 'root', parent_guid: null },
      ],
    );

    // A contribution in Jan 2025 with tax year override to 2024
    mockQueryRaw.mockImplementation(() => {
      if (mockQueryRaw.mock.calls.length <= 1) {
        return Promise.resolve([
          makeSplitRow({
            post_date: new Date('2025-01-15'),
          }),
        ]);
      }
      return Promise.resolve([{ guid: 'acct-401k', fullname: 'Assets:Retirement:401k' }]);
    });

    // Tax year override: split-1 belongs to tax year 2024
    mockTaxYearFindMany.mockResolvedValue([
      { split_guid: 'split-1', tax_year: 2024 },
    ]);

    const result = await generateContributionSummary(
      baseFilters({ startDate: '2025-01-01', endDate: '2025-12-31' }),
      'tax_year',
      null,
    );

    // Should be grouped under 2024 due to tax year override
    expect(result.periods.length).toBe(1);
    expect(result.periods[0].year).toBe(2024);
  });

  it('should group by calendar year ignoring tax year overrides', async () => {
    setupRetirementMocks(
      [{ account_guid: 'acct-401k', is_retirement: true, retirement_account_type: '401k' }],
      [
        { guid: 'acct-401k', parent_guid: 'root' },
        { guid: 'acct-checking', parent_guid: 'root' },
        { guid: 'root', parent_guid: null },
      ],
    );

    mockQueryRaw.mockImplementation(() => {
      if (mockQueryRaw.mock.calls.length <= 1) {
        return Promise.resolve([
          makeSplitRow({
            post_date: new Date('2025-01-15'),
          }),
        ]);
      }
      return Promise.resolve([{ guid: 'acct-401k', fullname: 'Assets:Retirement:401k' }]);
    });

    // Tax year override exists but should be ignored for calendar_year grouping
    mockTaxYearFindMany.mockResolvedValue([
      { split_guid: 'split-1', tax_year: 2024 },
    ]);

    const result = await generateContributionSummary(
      baseFilters({ startDate: '2025-01-01', endDate: '2025-12-31' }),
      'calendar_year',
      null,
    );

    expect(result.periods.length).toBe(1);
    expect(result.periods[0].year).toBe(2025);
  });

  // ---- 4. IRS limit integration ----

  it('should compute percentUsed from IRS limits', async () => {
    setupRetirementMocks(
      [{ account_guid: 'acct-401k', is_retirement: true, retirement_account_type: '401k' }],
      [
        { guid: 'acct-401k', parent_guid: 'root' },
        { guid: 'acct-checking', parent_guid: 'root' },
        { guid: 'root', parent_guid: null },
      ],
    );

    // $11,750 contribution (half of $23,500 limit)
    mockQueryRaw.mockImplementation(() => {
      if (mockQueryRaw.mock.calls.length <= 1) {
        return Promise.resolve([
          makeSplitRow({
            value_num: 1175000n,
            value_denom: 100n,
            quantity_num: 1175000n,
            quantity_denom: 100n,
            other_value_num: -1175000n,
            other_value_denom: 100n,
            other_quantity_num: -1175000n,
            other_quantity_denom: 100n,
          }),
        ]);
      }
      return Promise.resolve([{ guid: 'acct-401k', fullname: 'Assets:Retirement:401k' }]);
    });

    // No DB override, so default 2025 limits apply: base=23500, catchUp=7500
    mockContributionLimitsFindFirst.mockResolvedValue(null);

    const result = await generateContributionSummary(
      baseFilters(),
      'calendar_year',
      null, // no birthday => total = base only = 23500
    );

    expect(result.periods.length).toBe(1);
    const acct = result.periods[0].accounts[0];
    expect(acct.irsLimit).not.toBeNull();
    expect(acct.irsLimit!.base).toBe(23500);
    expect(acct.irsLimit!.total).toBe(23500);
    // 11750 / 23500 * 100 = 50%
    expect(acct.irsLimit!.percentUsed).toBe(50);
  });

  it('should include catch-up amount when birthday qualifies', async () => {
    setupRetirementMocks(
      [{ account_guid: 'acct-401k', is_retirement: true, retirement_account_type: '401k' }],
      [
        { guid: 'acct-401k', parent_guid: 'root' },
        { guid: 'acct-checking', parent_guid: 'root' },
        { guid: 'root', parent_guid: null },
      ],
    );

    mockQueryRaw.mockImplementation(() => {
      if (mockQueryRaw.mock.calls.length <= 1) {
        return Promise.resolve([makeSplitRow()]);
      }
      return Promise.resolve([{ guid: 'acct-401k', fullname: 'Assets:Retirement:401k' }]);
    });

    mockContributionLimitsFindFirst.mockResolvedValue(null);

    // Birthday: age 55 at end of 2025 => qualifies for catch-up (age >= 50)
    const result = await generateContributionSummary(
      baseFilters(),
      'calendar_year',
      '1970-06-15',
    );

    const acct = result.periods[0].accounts[0];
    expect(acct.irsLimit).not.toBeNull();
    expect(acct.irsLimit!.total).toBe(23500 + 7500); // base + catch-up
  });

  it('should skip IRS limits for brokerage accounts', async () => {
    setupRetirementMocks(
      [{ account_guid: 'acct-brokerage', is_retirement: true, retirement_account_type: 'brokerage' }],
      [
        { guid: 'acct-brokerage', parent_guid: 'root' },
        { guid: 'acct-checking', parent_guid: 'root' },
        { guid: 'root', parent_guid: null },
      ],
    );

    mockQueryRaw.mockImplementation(() => {
      if (mockQueryRaw.mock.calls.length <= 1) {
        return Promise.resolve([
          makeSplitRow({ account_guid: 'acct-brokerage' }),
        ]);
      }
      return Promise.resolve([{ guid: 'acct-brokerage', fullname: 'Assets:Investments:Brokerage' }]);
    });

    mockAccountsFindMany.mockImplementation((args: Record<string, unknown>) => {
      const select = (args as { select?: Record<string, unknown> }).select ?? {};
      if (select && (select as Record<string, unknown>).name) {
        return Promise.resolve([{ guid: 'acct-brokerage', name: 'Brokerage' }]);
      }
      return Promise.resolve([
        { guid: 'acct-brokerage', parent_guid: 'root' },
        { guid: 'acct-checking', parent_guid: 'root' },
        { guid: 'root', parent_guid: null },
      ]);
    });

    const result = await generateContributionSummary(
      baseFilters({ bookAccountGuids: ['acct-brokerage', 'acct-checking', 'root'] }),
      'calendar_year',
      null,
    );

    expect(result.periods.length).toBe(1);
    const acct = result.periods[0].accounts[0];
    expect(acct.irsLimit).toBeNull();
  });

  // ---- 5. Multiple accounts in same period ----

  it('should aggregate multiple accounts in the same period', async () => {
    mockAccountPreferencesFindMany.mockResolvedValue([
      { account_guid: 'acct-401k', is_retirement: true, retirement_account_type: '401k' },
      { account_guid: 'acct-roth', is_retirement: true, retirement_account_type: 'roth_ira' },
    ]);

    mockAccountsFindMany.mockImplementation((args: Record<string, unknown>) => {
      const select = (args as { select?: Record<string, unknown> }).select ?? {};
      if (select && (select as Record<string, unknown>).name) {
        return Promise.resolve([
          { guid: 'acct-401k', name: '401k' },
          { guid: 'acct-roth', name: 'Roth IRA' },
        ]);
      }
      return Promise.resolve([
        { guid: 'acct-401k', parent_guid: 'root' },
        { guid: 'acct-roth', parent_guid: 'root' },
        { guid: 'acct-checking', parent_guid: 'root' },
        { guid: 'root', parent_guid: null },
      ]);
    });

    mockQueryRaw.mockImplementation(() => {
      if (mockQueryRaw.mock.calls.length <= 1) {
        return Promise.resolve([
          // 401k contribution
          makeSplitRow({
            split_guid: 'split-401k',
            account_guid: 'acct-401k',
            value_num: 500000n,
            value_denom: 100n,
            quantity_num: 500000n,
            quantity_denom: 100n,
            other_value_num: -500000n,
            other_value_denom: 100n,
            other_quantity_num: -500000n,
            other_quantity_denom: 100n,
          }),
          // Roth IRA contribution
          makeSplitRow({
            split_guid: 'split-roth',
            account_guid: 'acct-roth',
            value_num: 300000n,
            value_denom: 100n,
            quantity_num: 300000n,
            quantity_denom: 100n,
            other_value_num: -300000n,
            other_value_denom: 100n,
            other_quantity_num: -300000n,
            other_quantity_denom: 100n,
          }),
        ]);
      }
      return Promise.resolve([
        { guid: 'acct-401k', fullname: 'Assets:Retirement:401k' },
        { guid: 'acct-roth', fullname: 'Assets:Retirement:Roth IRA' },
      ]);
    });

    const result = await generateContributionSummary(
      baseFilters({ bookAccountGuids: ['acct-401k', 'acct-roth', 'acct-checking', 'root'] }),
      'calendar_year',
      null,
    );

    expect(result.periods.length).toBe(1);
    expect(result.periods[0].accounts.length).toBe(2);
    // Sorted by accountPath
    expect(result.periods[0].accounts[0].accountPath).toBe('Assets:Retirement:401k');
    expect(result.periods[0].accounts[1].accountPath).toBe('Assets:Retirement:Roth IRA');
    expect(result.periods[0].totalContributions).toBe(5000 + 3000);
    expect(result.grandTotalContributions).toBe(8000);
  });

  // ---- 6. sumCents integer-cent accumulation ----

  it('should avoid floating-point drift via integer-cent accumulation', async () => {
    setupRetirementMocks(
      [{ account_guid: 'acct-401k', is_retirement: true, retirement_account_type: '401k' }],
      [
        { guid: 'acct-401k', parent_guid: 'root' },
        { guid: 'acct-checking', parent_guid: 'root' },
        { guid: 'root', parent_guid: null },
      ],
    );

    // Three amounts that cause floating-point drift if naively summed:
    // 0.1 + 0.2 + 0.3 should equal 0.6, not 0.6000000000000001
    mockQueryRaw.mockImplementation(() => {
      if (mockQueryRaw.mock.calls.length <= 1) {
        return Promise.resolve([
          makeSplitRow({
            split_guid: 'split-a',
            value_num: 10n, value_denom: 100n,
            quantity_num: 10n, quantity_denom: 100n,
            other_value_num: -10n, other_value_denom: 100n,
            other_quantity_num: -10n, other_quantity_denom: 100n,
          }),
          makeSplitRow({
            split_guid: 'split-b',
            value_num: 20n, value_denom: 100n,
            quantity_num: 20n, quantity_denom: 100n,
            other_split_guid: 'split-b-other',
            other_value_num: -20n, other_value_denom: 100n,
            other_quantity_num: -20n, other_quantity_denom: 100n,
          }),
          makeSplitRow({
            split_guid: 'split-c',
            value_num: 30n, value_denom: 100n,
            quantity_num: 30n, quantity_denom: 100n,
            other_split_guid: 'split-c-other',
            other_value_num: -30n, other_value_denom: 100n,
            other_quantity_num: -30n, other_quantity_denom: 100n,
          }),
        ]);
      }
      return Promise.resolve([{ guid: 'acct-401k', fullname: 'Assets:Retirement:401k' }]);
    });

    const result = await generateContributionSummary(
      baseFilters(),
      'calendar_year',
      null,
    );

    const acct = result.periods[0].accounts[0];
    // Should be exactly 0.6, not 0.6000000000000001
    expect(acct.contributions).toBe(0.6);
    expect(acct.netContributions).toBe(0.6);
  });

  // ---- Grand totals across multiple periods ----

  it('should compute grand totals across multiple periods', async () => {
    setupRetirementMocks(
      [{ account_guid: 'acct-401k', is_retirement: true, retirement_account_type: '401k' }],
      [
        { guid: 'acct-401k', parent_guid: 'root' },
        { guid: 'acct-checking', parent_guid: 'root' },
        { guid: 'root', parent_guid: null },
      ],
    );

    mockQueryRaw.mockImplementation(() => {
      if (mockQueryRaw.mock.calls.length <= 1) {
        return Promise.resolve([
          makeSplitRow({
            split_guid: 'split-2024',
            post_date: new Date('2024-06-15'),
            value_num: 1000000n, value_denom: 100n,
            quantity_num: 1000000n, quantity_denom: 100n,
            other_value_num: -1000000n, other_value_denom: 100n,
            other_quantity_num: -1000000n, other_quantity_denom: 100n,
          }),
          makeSplitRow({
            split_guid: 'split-2025',
            post_date: new Date('2025-06-15'),
            value_num: 2000000n, value_denom: 100n,
            quantity_num: 2000000n, quantity_denom: 100n,
            other_value_num: -2000000n, other_value_denom: 100n,
            other_quantity_num: -2000000n, other_quantity_denom: 100n,
          }),
        ]);
      }
      return Promise.resolve([{ guid: 'acct-401k', fullname: 'Assets:Retirement:401k' }]);
    });

    const result = await generateContributionSummary(
      baseFilters({ startDate: '2024-01-01', endDate: '2025-12-31' }),
      'calendar_year',
      null,
    );

    // Periods sorted descending by year
    expect(result.periods.length).toBe(2);
    expect(result.periods[0].year).toBe(2025);
    expect(result.periods[1].year).toBe(2024);

    expect(result.periods[0].totalContributions).toBe(20000);
    expect(result.periods[1].totalContributions).toBe(10000);
    expect(result.grandTotalContributions).toBe(30000);
  });
});
