import prisma from '@/lib/prisma';

export const RETIREMENT_ACCOUNT_TYPES = [
  '401k', '403b', '457', 'traditional_ira', 'roth_ira', 'sep_ira', 'simple_ira',
  'hsa', 'hra', 'fsa', 'education_529', 'coverdell_esa',
] as const;

export type RetirementAccountType = typeof RETIREMENT_ACCOUNT_TYPES[number] | 'brokerage';

/**
 * Types with no federal annual contribution limit — the limit resolver
 * returns null for these (529 plans have state-level aggregate caps only).
 */
const NO_FEDERAL_LIMIT_TYPES = new Set(['brokerage', 'education_529']);

interface LimitDefaults {
  account_type: string;
  base_limit: number;
  catch_up_limit: number;
  catch_up_age: number;
}

// Sources: 2024 Notice 2023-75 / Rev. Proc. 2023-23; 2025 Notice 2024-80 /
// Rev. Proc. 2024-25; 2026 Rev. Proc. 2025-32, Notice 2025-67, and
// Rev. Proc. 2025-19 (HSA). sep_ira is the employer/self-employed cap
// (IRC §415(c)) with no catch-up; coverdell_esa is a fixed $2,000/beneficiary.
const DEFAULT_LIMITS: Record<number, LimitDefaults[]> = {
  2024: [
    { account_type: '401k', base_limit: 23000, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '403b', base_limit: 23000, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '457', base_limit: 23000, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: 'traditional_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'roth_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'sep_ira', base_limit: 69000, catch_up_limit: 0, catch_up_age: 50 },
    { account_type: 'simple_ira', base_limit: 16000, catch_up_limit: 3500, catch_up_age: 50 },
    { account_type: 'hsa', base_limit: 4150, catch_up_limit: 1000, catch_up_age: 55 },
    { account_type: 'fsa', base_limit: 3200, catch_up_limit: 0, catch_up_age: 50 },
    { account_type: 'coverdell_esa', base_limit: 2000, catch_up_limit: 0, catch_up_age: 50 },
  ],
  2025: [
    { account_type: '401k', base_limit: 23500, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '403b', base_limit: 23500, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '457', base_limit: 23500, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: 'traditional_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'roth_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'sep_ira', base_limit: 70000, catch_up_limit: 0, catch_up_age: 50 },
    { account_type: 'simple_ira', base_limit: 16500, catch_up_limit: 3500, catch_up_age: 50 },
    { account_type: 'hsa', base_limit: 4300, catch_up_limit: 1000, catch_up_age: 55 },
    { account_type: 'fsa', base_limit: 3300, catch_up_limit: 0, catch_up_age: 50 },
    { account_type: 'coverdell_esa', base_limit: 2000, catch_up_limit: 0, catch_up_age: 50 },
  ],
  // 2026 per Rev. Proc. 2025-32 / Notice 2025-67 (retirement) and
  // Rev. Proc. 2025-19 (HSA)
  2026: [
    { account_type: '401k', base_limit: 24500, catch_up_limit: 8000, catch_up_age: 50 },
    { account_type: '403b', base_limit: 24500, catch_up_limit: 8000, catch_up_age: 50 },
    { account_type: '457', base_limit: 24500, catch_up_limit: 8000, catch_up_age: 50 },
    { account_type: 'traditional_ira', base_limit: 7500, catch_up_limit: 1100, catch_up_age: 50 },
    { account_type: 'roth_ira', base_limit: 7500, catch_up_limit: 1100, catch_up_age: 50 },
    { account_type: 'sep_ira', base_limit: 72000, catch_up_limit: 0, catch_up_age: 50 },
    { account_type: 'simple_ira', base_limit: 17000, catch_up_limit: 4000, catch_up_age: 50 },
    { account_type: 'hsa', base_limit: 4400, catch_up_limit: 1000, catch_up_age: 55 },
    { account_type: 'fsa', base_limit: 3400, catch_up_limit: 0, catch_up_age: 50 },
    { account_type: 'coverdell_esa', base_limit: 2000, catch_up_limit: 0, catch_up_age: 50 },
  ],
};

export function getDefaultLimits(year: number): LimitDefaults[] {
  return DEFAULT_LIMITS[year] ?? [];
}

export function calculateAge(birthday: string, asOfDate: Date): number | null {
  if (!birthday) return null;
  const birth = new Date(birthday);
  if (isNaN(birth.getTime())) return null;

  let age = asOfDate.getFullYear() - birth.getFullYear();
  const monthDiff = asOfDate.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOfDate.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

export interface ContributionLimitResult {
  base: number;
  catchUp: number;
  total: number;
  catchUpAge: number;
}

export async function getContributionLimit(
  taxYear: number,
  accountType: string,
  birthday: string | null,
): Promise<ContributionLimitResult | null> {
  if (NO_FEDERAL_LIMIT_TYPES.has(accountType)) return null;

  const dbLimit = await prisma.gnucash_web_contribution_limits.findFirst({
    where: { tax_year: taxYear, account_type: accountType },
  });

  let base: number;
  let catchUp: number;
  let catchUpAge: number;

  if (dbLimit) {
    base = Number(dbLimit.base_limit);
    catchUp = Number(dbLimit.catch_up_limit);
    catchUpAge = dbLimit.catch_up_age;
  } else {
    const defaults = getDefaultLimits(taxYear);
    const match = defaults.find(d => d.account_type === accountType);
    if (!match) return null;
    base = match.base_limit;
    catchUp = match.catch_up_limit;
    catchUpAge = match.catch_up_age;
  }

  let total = base;
  if (birthday) {
    const ageAtYearEnd = calculateAge(birthday, new Date(`${taxYear}-12-31`));
    if (ageAtYearEnd !== null && ageAtYearEnd >= catchUpAge) {
      total = base + catchUp;
    }
  }

  return { base, catchUp, total, catchUpAge };
}

export async function getAllLimitsForYear(taxYear: number): Promise<Array<LimitDefaults & { isOverride: boolean }>> {
  const dbLimits = await prisma.gnucash_web_contribution_limits.findMany({
    where: { tax_year: taxYear },
  });

  const defaults = getDefaultLimits(taxYear);
  const result: Array<LimitDefaults & { isOverride: boolean }> = [];

  for (const def of defaults) {
    const override = dbLimits.find(d => d.account_type === def.account_type);
    if (override) {
      result.push({
        account_type: override.account_type,
        base_limit: Number(override.base_limit),
        catch_up_limit: Number(override.catch_up_limit),
        catch_up_age: override.catch_up_age,
        isOverride: true,
      });
    } else {
      result.push({ ...def, isOverride: false });
    }
  }

  for (const dbLimit of dbLimits) {
    if (!defaults.find(d => d.account_type === dbLimit.account_type)) {
      result.push({
        account_type: dbLimit.account_type,
        base_limit: Number(dbLimit.base_limit),
        catch_up_limit: Number(dbLimit.catch_up_limit),
        catch_up_age: dbLimit.catch_up_age,
        isOverride: true,
      });
    }
  }

  return result;
}
