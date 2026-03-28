import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockContributionLimitsFindFirst = vi.fn();
const mockContributionLimitsFindMany = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    gnucash_web_contribution_limits: {
      findFirst: (...args: unknown[]) => mockContributionLimitsFindFirst(...args),
      findMany: (...args: unknown[]) => mockContributionLimitsFindMany(...args),
    },
  },
}));

import { getContributionLimit, getDefaultLimits, calculateAge, RETIREMENT_ACCOUNT_TYPES } from '../reports/irs-limits';

describe('IRS Contribution Limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('RETIREMENT_ACCOUNT_TYPES', () => {
    it('should include all standard retirement account types', () => {
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('401k');
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('traditional_ira');
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('roth_ira');
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('hsa');
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('403b');
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('457');
    });
  });

  describe('calculateAge', () => {
    it('should calculate age from birthday string', () => {
      const age = calculateAge('1980-06-15', new Date('2026-03-27'));
      expect(age).toBe(45);
    });

    it('should handle birthday not yet passed this year', () => {
      const age = calculateAge('1975-12-25', new Date('2026-03-27'));
      expect(age).toBe(50);
    });

    it('should handle birthday already passed this year', () => {
      const age = calculateAge('1975-01-01', new Date('2026-03-27'));
      expect(age).toBe(51);
    });

    it('should return null for invalid birthday', () => {
      const age = calculateAge('', new Date('2026-03-27'));
      expect(age).toBeNull();
    });
  });

  describe('getDefaultLimits', () => {
    it('should return known limits for 2025', () => {
      const limits = getDefaultLimits(2025);
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: '401k', base_limit: 23500, catch_up_limit: 7500 })
      );
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: 'roth_ira', base_limit: 7000, catch_up_limit: 1000 })
      );
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: 'traditional_ira', base_limit: 7000, catch_up_limit: 1000 })
      );
    });

    it('should return empty array for unknown year', () => {
      const limits = getDefaultLimits(2010);
      expect(limits).toEqual([]);
    });
  });

  describe('getContributionLimit', () => {
    it('should return DB override when available', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue({
        tax_year: 2025,
        account_type: '401k',
        base_limit: 24000,
        catch_up_limit: 8000,
        catch_up_age: 50,
      });

      const limit = await getContributionLimit(2025, '401k', null);
      expect(limit).toEqual({ base: 24000, catchUp: 8000, total: 24000, catchUpAge: 50 });
    });

    it('should fall back to defaults when no DB override', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      const limit = await getContributionLimit(2025, '401k', null);
      expect(limit).toEqual({ base: 23500, catchUp: 7500, total: 23500, catchUpAge: 50 });
    });

    it('should include catch-up amount when user is over catch-up age', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      const limit = await getContributionLimit(2025, '401k', '1970-06-15');
      expect(limit).toEqual({ base: 23500, catchUp: 7500, total: 31000, catchUpAge: 50 });
    });

    it('should not include catch-up when user is under catch-up age', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      const limit = await getContributionLimit(2025, '401k', '1990-06-15');
      expect(limit).toEqual({ base: 23500, catchUp: 7500, total: 23500, catchUpAge: 50 });
    });

    it('should return null for brokerage accounts (no IRS limit)', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      const limit = await getContributionLimit(2025, 'brokerage', null);
      expect(limit).toBeNull();
    });
  });
});
