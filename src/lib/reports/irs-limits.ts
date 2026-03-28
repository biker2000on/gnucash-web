import prisma from '@/lib/prisma';

export const RETIREMENT_ACCOUNT_TYPES = [
  '401k', '403b', '457', 'traditional_ira', 'roth_ira', 'hsa',
] as const;

export type RetirementAccountType = typeof RETIREMENT_ACCOUNT_TYPES[number] | 'brokerage';

interface LimitDefaults {
  account_type: string;
  base_limit: number;
  catch_up_limit: number;
  catch_up_age: number;
}

const DEFAULT_LIMITS: Record<number, LimitDefaults[]> = {
  2024: [
    { account_type: '401k', base_limit: 23000, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '403b', base_limit: 23000, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '457', base_limit: 23000, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: 'traditional_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'roth_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'hsa', base_limit: 4150, catch_up_limit: 1000, catch_up_age: 55 },
  ],
  2025: [
    { account_type: '401k', base_limit: 23500, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '403b', base_limit: 23500, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '457', base_limit: 23500, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: 'traditional_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'roth_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'hsa', base_limit: 4300, catch_up_limit: 1000, catch_up_age: 55 },
  ],
  2026: [
    { account_type: '401k', base_limit: 23500, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '403b', base_limit: 23500, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '457', base_limit: 23500, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: 'traditional_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'roth_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'hsa', base_limit: 4300, catch_up_limit: 1000, catch_up_age: 55 },
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
  if (accountType === 'brokerage') return null;

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
