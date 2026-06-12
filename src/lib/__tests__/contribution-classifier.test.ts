import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAccountsFindMany = vi.fn();
const mockAccountPreferencesFindMany = vi.fn();
const mockAccountPreferencesFindFirst = vi.fn();
const mockTaxYearFindFirst = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    accounts: {
      findMany: (...args: unknown[]) => mockAccountsFindMany(...args),
    },
    gnucash_web_account_preferences: {
      findMany: (...args: unknown[]) => mockAccountPreferencesFindMany(...args),
      findFirst: (...args: unknown[]) => mockAccountPreferencesFindFirst(...args),
    },
    gnucash_web_contribution_tax_year: {
      findFirst: (...args: unknown[]) => mockTaxYearFindFirst(...args),
    },
  },
}));

import {
  classifyContribution,
  ContributionType,
  getRetirementAccountGuids,
  resolveContributionTaxYear,
} from '../reports/contribution-classifier';

function mockSplit(overrides: Record<string, unknown> = {}) {
  return {
    guid: 'split-1',
    account_guid: 'acct-retirement',
    value_num: 650000n,
    value_denom: 100n,
    quantity_num: 650000n,
    quantity_denom: 100n,
    ...overrides,
  };
}

function mockOtherSplit(overrides: Record<string, unknown> = {}) {
  return {
    guid: 'split-2',
    account_guid: 'acct-checking',
    value_num: -650000n,
    value_denom: 100n,
    quantity_num: -650000n,
    quantity_denom: 100n,
    account: {
      account_type: 'BANK',
      commodity_guid: 'usd-guid',
      name: 'Checking Account',
    },
    ...overrides,
  };
}

describe('Contribution Classifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('classifyContribution', () => {
    const retirementGuids = new Set(['acct-retirement', 'acct-retirement-cash', 'acct-401k']);

    it('should classify cash from BANK as CONTRIBUTION', () => {
      const split = mockSplit();
      const otherSplits = [mockOtherSplit()];
      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.CONTRIBUTION);
    });

    it('should classify cash from another retirement account as TRANSFER', () => {
      const split = mockSplit();
      const otherSplits = [mockOtherSplit({
        account_guid: 'acct-401k',
        account: { account_type: 'ASSET', commodity_guid: 'usd-guid', name: '401k Cash' },
      })];
      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.TRANSFER);
    });

    it('should classify cash from INCOME as EMPLOYER_MATCH when description matches', () => {
      const split = mockSplit();
      const otherSplits = [mockOtherSplit({
        account: { account_type: 'INCOME', commodity_guid: 'usd-guid', name: 'Employer Match' },
      })];
      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.EMPLOYER_MATCH);
    });

    it('should classify cash from INCOME (non-match) as INCOME_CONTRIBUTION', () => {
      const split = mockSplit();
      const otherSplits = [mockOtherSplit({
        account: { account_type: 'INCOME', commodity_guid: 'usd-guid', name: 'Salary' },
      })];
      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.INCOME_CONTRIBUTION);
    });

    it('should classify cash from EXPENSE as FEE', () => {
      const split = mockSplit();
      const otherSplits = [mockOtherSplit({
        account: { account_type: 'EXPENSE', commodity_guid: 'usd-guid', name: 'Investment Fees' },
      })];
      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.FEE);
    });

    it('should classify negative value as WITHDRAWAL', () => {
      const split = mockSplit({ value_num: -650000n });
      const otherSplits = [mockOtherSplit({ value_num: 650000n })];
      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.WITHDRAWAL);
    });

    it('should classify genuine withdrawal to checking as WITHDRAWAL', () => {
      // Money leaving retirement cash to an external BANK account
      const split = mockSplit({
        account_guid: 'acct-retirement-cash',
        value_num: -500000n,
        quantity_num: -500000n,
      });
      const otherSplits = [mockOtherSplit({
        account_guid: 'acct-checking',
        value_num: 500000n,
        quantity_num: 500000n,
      })];
      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.WITHDRAWAL);
    });

    describe('internal buy inside 401k (cash -> stock under same retirement umbrella)', () => {
      const buyGuids = new Set(['acct-401k', 'acct-401k-cash', 'acct-401k-stock']);

      it('should classify the cash leg (negative) as TRANSFER, not WITHDRAWAL', () => {
        const cashLeg = mockSplit({
          account_guid: 'acct-401k-cash',
          value_num: -300002n,
          quantity_num: -300002n,
        });
        const otherSplits = [
          mockOtherSplit({
            guid: 'split-stock',
            account_guid: 'acct-401k-stock',
            value_num: 300002n,
            quantity_num: 102181n,
            quantity_denom: 1000n,
            account: { account_type: 'MUTUAL', commodity_guid: 'vwusx-guid', name: 'VWUSX' },
          }),
          // GnuCash trading splits mirror the real splits
          mockOtherSplit({
            guid: 'split-trading-usd',
            account_guid: 'acct-trading-usd',
            value_num: 300002n,
            quantity_num: 300002n,
            account: { account_type: 'TRADING', commodity_guid: 'usd-guid', name: 'USD' },
          }),
          mockOtherSplit({
            guid: 'split-trading-fund',
            account_guid: 'acct-trading-fund',
            value_num: -300002n,
            quantity_num: -102181n,
            quantity_denom: 1000n,
            account: { account_type: 'TRADING', commodity_guid: 'vwusx-guid', name: 'VWUSX' },
          }),
        ];
        const result = classifyContribution(cashLeg, otherSplits, buyGuids);
        expect(result).toBe(ContributionType.TRANSFER);
      });

      it('should classify the stock leg (positive) as TRANSFER, not CONTRIBUTION', () => {
        const stockLeg = mockSplit({
          account_guid: 'acct-401k-stock',
          value_num: 300002n,
          quantity_num: 102181n,
          quantity_denom: 1000n,
        });
        const otherSplits = [
          mockOtherSplit({
            guid: 'split-cash',
            account_guid: 'acct-401k-cash',
            value_num: -300002n,
            quantity_num: -300002n,
            account: { account_type: 'CASH', commodity_guid: 'usd-guid', name: 'Cash' },
          }),
          mockOtherSplit({
            guid: 'split-trading-usd',
            account_guid: 'acct-trading-usd',
            value_num: 300002n,
            quantity_num: 300002n,
            account: { account_type: 'TRADING', commodity_guid: 'usd-guid', name: 'USD' },
          }),
          mockOtherSplit({
            guid: 'split-trading-fund',
            account_guid: 'acct-trading-fund',
            value_num: -300002n,
            quantity_num: -102181n,
            quantity_denom: 1000n,
            account: { account_type: 'TRADING', commodity_guid: 'vwusx-guid', name: 'VWUSX' },
          }),
        ];
        const result = classifyContribution(stockLeg, otherSplits, buyGuids);
        expect(result).toBe(ContributionType.TRANSFER);
      });

      it('should classify both legs of a sell inside the 401k as TRANSFER', () => {
        // Sell: stock leg negative, cash leg positive
        const stockLeg = mockSplit({
          account_guid: 'acct-401k-stock',
          value_num: -150000n,
          quantity_num: -50000n,
          quantity_denom: 1000n,
        });
        const sellOthers = [
          mockOtherSplit({
            guid: 'split-cash',
            account_guid: 'acct-401k-cash',
            value_num: 150000n,
            quantity_num: 150000n,
            account: { account_type: 'CASH', commodity_guid: 'usd-guid', name: 'Cash' },
          }),
        ];
        expect(classifyContribution(stockLeg, sellOthers, buyGuids)).toBe(ContributionType.TRANSFER);

        const cashLeg = mockSplit({
          account_guid: 'acct-401k-cash',
          value_num: 150000n,
          quantity_num: 150000n,
        });
        const cashOthers = [
          mockOtherSplit({
            guid: 'split-stock',
            account_guid: 'acct-401k-stock',
            value_num: -150000n,
            quantity_num: -50000n,
            quantity_denom: 1000n,
            account: { account_type: 'MUTUAL', commodity_guid: 'vwusx-guid', name: 'VWUSX' },
          }),
        ];
        expect(classifyContribution(cashLeg, cashOthers, buyGuids)).toBe(ContributionType.TRANSFER);
      });
    });

    it('should classify rollover between two retirement accounts as TRANSFER on both legs', () => {
      // Outgoing leg: old 401k cash -> rollover IRA
      const outgoing = mockSplit({
        account_guid: 'acct-401k',
        value_num: -2000000n,
        quantity_num: -2000000n,
      });
      const outgoingOthers = [mockOtherSplit({
        guid: 'split-ira',
        account_guid: 'acct-retirement',
        value_num: 2000000n,
        quantity_num: 2000000n,
        account: { account_type: 'ASSET', commodity_guid: 'usd-guid', name: 'Rollover IRA' },
      })];
      expect(classifyContribution(outgoing, outgoingOthers, retirementGuids)).toBe(ContributionType.TRANSFER);

      // Incoming leg: rollover IRA receives from old 401k
      const incoming = mockSplit({
        account_guid: 'acct-retirement',
        value_num: 2000000n,
        quantity_num: 2000000n,
      });
      const incomingOthers = [mockOtherSplit({
        guid: 'split-401k',
        account_guid: 'acct-401k',
        value_num: -2000000n,
        quantity_num: -2000000n,
        account: { account_type: 'ASSET', commodity_guid: 'usd-guid', name: 'Old 401k' },
      })];
      expect(classifyContribution(incoming, incomingOthers, retirementGuids)).toBe(ContributionType.TRANSFER);
    });

    it('should classify share transfer as TRANSFER', () => {
      const split = mockSplit({
        quantity_num: 100000n,
        quantity_denom: 10000n,
        value_num: 0n,
      });
      const otherSplits = [mockOtherSplit({
        account_guid: 'acct-other-brokerage',
        quantity_num: -100000n,
        quantity_denom: 10000n,
        value_num: 0n,
        account: { account_type: 'STOCK', commodity_guid: 'aapl-guid', name: 'Old Brokerage:AAPL' },
      })];
      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.TRANSFER);
    });

    it('should handle multi-split with mixed sources (primary source wins)', () => {
      const split = mockSplit({ value_num: 1000000n });
      const otherSplits = [
        mockOtherSplit({ value_num: -800000n }),
        mockOtherSplit({
          guid: 'split-3',
          account_guid: 'acct-fee',
          value_num: -200000n,
          account: { account_type: 'EXPENSE', commodity_guid: 'usd-guid', name: 'Fee' },
        }),
      ];
      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.CONTRIBUTION);
    });

    it('should classify zero-value split as OTHER', () => {
      const split = mockSplit({ value_num: 0n, quantity_num: 0n });
      const otherSplits = [mockOtherSplit({ value_num: 0n })];
      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.OTHER);
    });
  });

  describe('getRetirementAccountGuids', () => {
    it('should return guids of accounts flagged as retirement', async () => {
      mockAccountPreferencesFindMany.mockResolvedValue([
        { account_guid: 'guid-1', is_retirement: true },
        { account_guid: 'guid-2', is_retirement: true },
      ]);
      mockAccountsFindMany.mockResolvedValue([
        { guid: 'guid-1', parent_guid: 'root' },
        { guid: 'guid-1a', parent_guid: 'guid-1' },
        { guid: 'guid-2', parent_guid: 'root' },
        { guid: 'guid-3', parent_guid: 'root' },
      ]);

      const result = await getRetirementAccountGuids(['guid-1', 'guid-1a', 'guid-2', 'guid-3']);
      expect(result).toContain('guid-1');
      expect(result).toContain('guid-1a');
      expect(result).toContain('guid-2');
      expect(result).not.toContain('guid-3');
    });

    it('should return empty set when no accounts are flagged', async () => {
      mockAccountPreferencesFindMany.mockResolvedValue([]);
      mockAccountsFindMany.mockResolvedValue([]);

      const result = await getRetirementAccountGuids([]);
      expect(result.size).toBe(0);
    });
  });

  describe('resolveContributionTaxYear', () => {
    it('should return override tax year when set', async () => {
      mockTaxYearFindFirst.mockResolvedValue({ split_guid: 'split-1', tax_year: 2024 });
      const year = await resolveContributionTaxYear('split-1', new Date('2025-02-15'));
      expect(year).toBe(2024);
    });

    it('should return calendar year from post_date when no override', async () => {
      mockTaxYearFindFirst.mockResolvedValue(null);
      const year = await resolveContributionTaxYear('split-1', new Date('2025-07-20'));
      expect(year).toBe(2025);
    });
  });
});
