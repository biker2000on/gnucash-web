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

    it('should include SEP/SIMPLE IRA and education account types', () => {
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('sep_ira');
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('simple_ira');
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('education_529');
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('coverdell_esa');
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

    it('should return SEP/SIMPLE/ESA limits for 2025', () => {
      const limits = getDefaultLimits(2025);
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: 'sep_ira', base_limit: 70000, catch_up_limit: 0 })
      );
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: 'simple_ira', base_limit: 16500, catch_up_limit: 3500 })
      );
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: 'coverdell_esa', base_limit: 2000, catch_up_limit: 0 })
      );
    });

    it('should return 2026 limits per Rev. Proc. 2025-32 / 2025-19', () => {
      const limits = getDefaultLimits(2026);
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: '401k', base_limit: 24500, catch_up_limit: 8000 })
      );
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: '403b', base_limit: 24500, catch_up_limit: 8000 })
      );
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: '457', base_limit: 24500, catch_up_limit: 8000 })
      );
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: 'traditional_ira', base_limit: 7500, catch_up_limit: 1100 })
      );
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: 'roth_ira', base_limit: 7500, catch_up_limit: 1100 })
      );
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: 'sep_ira', base_limit: 72000, catch_up_limit: 0 })
      );
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: 'simple_ira', base_limit: 17000, catch_up_limit: 4000 })
      );
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: 'hsa', base_limit: 4400, catch_up_limit: 1000, catch_up_age: 55 })
      );
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: 'fsa', base_limit: 3400, catch_up_limit: 0 })
      );
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: 'coverdell_esa', base_limit: 2000, catch_up_limit: 0 })
      );
      // 529 plans have no federal annual limit — no default row
      expect(limits.find(l => l.account_type === 'education_529')).toBeUndefined();
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

    it('should return null for 529 plans (no federal annual limit)', async () => {
      const limit = await getContributionLimit(2026, 'education_529', null);
      expect(limit).toBeNull();
      expect(mockContributionLimitsFindFirst).not.toHaveBeenCalled();
    });

    it('should not add catch-up for sep_ira even when over 50', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      const limit = await getContributionLimit(2026, 'sep_ira', '1970-06-15');
      expect(limit).toEqual({ base: 72000, catchUp: 0, total: 72000, catchUpAge: 50 });
    });

    it('should add SIMPLE IRA catch-up when over 50 (2026: 17,000 + 4,000)', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      const limit = await getContributionLimit(2026, 'simple_ira', '1970-06-15');
      expect(limit).toEqual({ base: 17000, catchUp: 4000, total: 21000, catchUpAge: 50 });
    });
  });
});
