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

import { getContributionLimit, getDefaultLimits, getDefaultNecThreshold, getNecThreshold, calculateAge, RETIREMENT_ACCOUNT_TYPES, NEC_THRESHOLD_OVERRIDE_ACCOUNT_TYPE } from '../reports/irs-limits';

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

    it('should include the family-coverage HSA type', () => {
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('hsa_family');
    });
  });

  describe('1099-NEC thresholds', () => {
    it('uses verified year-keyed defaults and leaves future inflation adjustments unknown', () => {
      expect(getDefaultNecThreshold(2024)).toBe(600);
      expect(getDefaultNecThreshold(2021)).toBe(600);
      expect(getDefaultNecThreshold(2022)).toBe(600);
      expect(getDefaultNecThreshold(2023)).toBe(600);
      expect(getDefaultNecThreshold(2025)).toBe(600);
      expect(getDefaultNecThreshold(2026)).toBe(2_000);
      expect(getDefaultNecThreshold(2027)).toBeNull();
    });

    it('accepts the existing annual-limit-table override for a reviewed threshold', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue({ base_limit: 2_125 });
      await expect(getNecThreshold(2027)).resolves.toBe(2_125);
      expect(mockContributionLimitsFindFirst).toHaveBeenCalledWith({
        where: { tax_year: 2027, account_type: NEC_THRESHOLD_OVERRIDE_ACCOUNT_TYPE },
      });
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

    it('does not grant age one day early for a Dec 31 birthday (local parsing previously made Los Angeles users appear older)', () => {
      // This is Dec 30 in both UTC and America/Los_Angeles. Before the UTC/local
      // mix-up was fixed, LA parsed the birthday as Dec 30 and returned 50.
      const age = calculateAge('1976-12-31', new Date('2026-12-30T12:00:00Z'));
      expect(age).toBe(49);
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

    it('should return family-coverage HSA limits for all supported years', () => {
      // Rev. Proc. 2023-23 (2024), 2024-25 (2025), 2025-19 (2026); the $1,000
      // HSA catch-up (age 55+) applies to both coverage tiers.
      expect(getDefaultLimits(2024)).toContainEqual(
        expect.objectContaining({ account_type: 'hsa_family', base_limit: 8300, catch_up_limit: 1000, catch_up_age: 55 })
      );
      expect(getDefaultLimits(2025)).toContainEqual(
        expect.objectContaining({ account_type: 'hsa_family', base_limit: 8550, catch_up_limit: 1000, catch_up_age: 55 })
      );
      expect(getDefaultLimits(2026)).toContainEqual(
        expect.objectContaining({ account_type: 'hsa_family', base_limit: 8750, catch_up_limit: 1000, catch_up_age: 55 })
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
      expect(limit).toMatchObject({ base: 24000, catchUp: 8000, total: 24000, catchUpAge: 50 });
    });

    it('should fall back to defaults when no DB override', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      const limit = await getContributionLimit(2025, '401k', null);
      expect(limit).toMatchObject({ base: 23500, catchUp: 7500, total: 23500, catchUpAge: 50 });
    });

    it('should include catch-up amount when user is over catch-up age', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      const limit = await getContributionLimit(2025, '401k', '1970-06-15');
      expect(limit).toMatchObject({ base: 23500, catchUp: 7500, total: 31000, catchUpAge: 50 });
    });

    it('should not include catch-up when user is under catch-up age', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      const limit = await getContributionLimit(2025, '401k', '1990-06-15');
      expect(limit).toMatchObject({ base: 23500, catchUp: 7500, total: 23500, catchUpAge: 50 });
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
      expect(limit).toMatchObject({ base: 72000, catchUp: 0, total: 72000, catchUpAge: 50 });
    });

    it('should add family HSA catch-up at 55+ (2026: 8,750 + 1,000)', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      const limit = await getContributionLimit(2026, 'hsa_family', '1968-06-15');
      expect(limit).toMatchObject({ base: 8750, catchUp: 1000, total: 9750, catchUpAge: 55 });
    });

    it('should not add family HSA catch-up under 55', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      const limit = await getContributionLimit(2026, 'hsa_family', '1980-06-15');
      expect(limit).toMatchObject({ base: 8750, catchUp: 1000, total: 8750, catchUpAge: 55 });
    });

    it('should add SIMPLE IRA catch-up when over 50 (2026: 17,000 + 4,000)', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      const limit = await getContributionLimit(2026, 'simple_ira', '1970-06-15');
      expect(limit).toMatchObject({ base: 17000, catchUp: 4000, total: 21000, catchUpAge: 50 });
    });
  });

  // SECURE 2.0 §109, effective for tax years beginning after 2024.
  // Notice 2024-80 (2025) / Notice 2025-67 (2026): $11,250 for 401(k)/403(b)/
  // 457(b) and $5,250 for SIMPLE plans in both years.
  describe('SECURE 2.0 age 60-63 super catch-up', () => {
    beforeEach(() => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);
    });

    it('replaces the ordinary 401k catch-up at age 61 (2025: 23,500 + 11,250 = 34,750)', async () => {
      const limit = await getContributionLimit(2025, '401k', '1964-06-15');
      expect(limit?.total).toBe(34_750);
      expect(limit).toMatchObject({
        base: 23_500,
        catchUp: 7_500,
        superCatchUp: 11_250,
        catchUpApplied: 11_250,
        superCatchUpApplied: true,
      });
    });

    it('applies at the age-60 and age-63 boundaries', async () => {
      // 60 at 2025 year end
      expect((await getContributionLimit(2025, '401k', '1965-06-15'))?.total).toBe(34_750);
      // 63 at 2025 year end
      expect((await getContributionLimit(2025, '401k', '1962-06-15'))?.total).toBe(34_750);
    });

    it('reverts to the ordinary catch-up at 64', async () => {
      const limit = await getContributionLimit(2025, '401k', '1961-06-15');
      expect(limit?.total).toBe(31_000);
      expect(limit?.superCatchUpApplied).toBe(false);
      expect(limit?.catchUpApplied).toBe(7_500);
    });

    it('does not apply for 2024 — the provision starts in 2025', async () => {
      const limit = await getContributionLimit(2024, '401k', '1963-06-15');
      expect(limit?.total).toBe(30_500); // 23,000 + 7,500
      expect(limit?.superCatchUp).toBe(0);
    });

    it('SIMPLE plans use $5,250 (2025: 16,500 + 5,250 = 21,750)', async () => {
      const limit = await getContributionLimit(2025, 'simple_ira', '1964-06-15');
      expect(limit?.total).toBe(21_750);
      expect(limit?.superCatchUpApplied).toBe(true);
    });

    it('2026 keeps $11,250 / $5,250 (24,500 + 11,250 = 35,750)', async () => {
      expect((await getContributionLimit(2026, '401k', '1965-06-15'))?.total).toBe(35_750);
      expect((await getContributionLimit(2026, 'simple_ira', '1965-06-15'))?.total).toBe(22_250);
    });

    it('IRAs get no super catch-up', async () => {
      const limit = await getContributionLimit(2025, 'traditional_ira', '1964-06-15');
      expect(limit?.total).toBe(8_000); // 7,000 + 1,000 ordinary catch-up
      expect(limit?.superCatchUp).toBe(0);
    });
  });
});
