/**
 * Browser-safe IRS contribution-limit and 1099-NEC threshold tables, plus the
 * pure arithmetic over them (catch-up / SECURE 2.0 super catch-up resolution).
 *
 * This module must stay free of database, service, and Node-only imports — it
 * is reachable from Client Components, and importing prisma here pulls the
 * Postgres driver into the browser bundle and breaks `next build`.
 * `@/lib/age` is a zero-import leaf and is safe.
 *
 * The DB-override lookups live in the server-only sibling
 * `@/lib/reports/irs-limits`, which re-exports everything here so existing
 * server consumers keep a single import site.
 */

import { calculateCalendarAge } from '@/lib/age';

export const RETIREMENT_ACCOUNT_TYPES = [
  '401k', '403b', '457', 'traditional_ira', 'roth_ira', 'sep_ira', 'simple_ira',
  'hsa', 'hsa_family', 'hra', 'fsa', 'education_529', 'coverdell_esa',
] as const;

export type RetirementAccountType = typeof RETIREMENT_ACCOUNT_TYPES[number] | 'brokerage';

/**
 * Types with no federal annual contribution limit — the limit resolver
 * returns null for these (529 plans have state-level aggregate caps only).
 */
export const NO_FEDERAL_LIMIT_TYPES = new Set(['brokerage', 'education_529']);

/**
 * The existing annual-limit override table also stores this non-contribution
 * statutory threshold under this reserved account_type.  Keeping it here
 * gives the 1099 tracker the same year-keyed default/DB-override behavior as
 * the contribution-limit resolver without creating another settings store.
 */
export const NEC_THRESHOLD_OVERRIDE_ACCOUNT_TYPE = '1099_nec_threshold';

// IRS: 2025 Instructions for Forms 1099-MISC and 1099-NEC; IRS "Am I
// required to file a Form 1099?" (updated 2026-07) says $600 for payments
// before 2026 and $2,000 for payments made in 2026.  Later years are omitted
// intentionally: the IRS says they are inflation-adjusted.
const NEC_THRESHOLD_DEFAULTS: Readonly<Record<number, number>> = {
  2021: 600,
  2022: 600,
  2023: 600,
  2024: 600,
  2025: 600,
  2026: 2_000,
};

/** Built-in 1099-NEC threshold, or null where no verified default exists. */
export function getDefaultNecThreshold(taxYear: number): number | null {
  return NEC_THRESHOLD_DEFAULTS[taxYear] ?? null;
}

export interface LimitDefaults {
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
    // IRS family-coverage HSA limit; catch-up is per account holder (55+)
    { account_type: 'hsa_family', base_limit: 8300, catch_up_limit: 1000, catch_up_age: 55 },
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
    // IRS family-coverage HSA limit; catch-up is per account holder (55+)
    { account_type: 'hsa_family', base_limit: 8550, catch_up_limit: 1000, catch_up_age: 55 },
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
    // IRS family-coverage HSA limit; catch-up is per account holder (55+)
    { account_type: 'hsa_family', base_limit: 8750, catch_up_limit: 1000, catch_up_age: 55 },
    { account_type: 'fsa', base_limit: 3400, catch_up_limit: 0, catch_up_age: 50 },
    { account_type: 'coverdell_esa', base_limit: 2000, catch_up_limit: 0, catch_up_age: 50 },
  ],
};

/**
 * SECURE 2.0 §109 "super catch-up". For a participant who is 60, 61, 62, or 63
 * at year end, the ordinary catch-up is REPLACED (not stacked) by a higher
 * amount; at 64 the limit reverts to the ordinary catch-up.
 *
 * Effective for tax years beginning after 2024, so 2024 has none.
 * Sources: Notice 2024-80 (2025) and Notice 2025-67 (2026) —
 * $11,250 for 401(k)/403(b)/governmental 457(b) and $5,250 for SIMPLE plans in
 * BOTH years. IRA catch-ups are not eligible for the super catch-up.
 */
const SUPER_CATCH_UP_LIMITS: Record<number, Record<string, number>> = {
  2025: { '401k': 11_250, '403b': 11_250, '457': 11_250, simple_ira: 5_250 },
  2026: { '401k': 11_250, '403b': 11_250, '457': 11_250, simple_ira: 5_250 },
};

const SUPER_CATCH_UP_MIN_AGE = 60;
const SUPER_CATCH_UP_MAX_AGE = 63;

/** The super catch-up amount for a year+type, or 0 when none applies. */
export function getSuperCatchUpLimit(taxYear: number, accountType: string): number {
  return SUPER_CATCH_UP_LIMITS[taxYear]?.[accountType] ?? 0;
}

export function getDefaultLimits(year: number): LimitDefaults[] {
  return DEFAULT_LIMITS[year] ?? [];
}

export function calculateAge(birthday: string, asOfDate: Date): number | null {
  if (!birthday) return null;
  return calculateCalendarAge(birthday, asOfDate, 'utc');
}

export interface ContributionLimitResult {
  base: number;
  /** Ordinary catch-up amount for this plan type. */
  catchUp: number;
  total: number;
  catchUpAge: number;
  /**
   * SECURE 2.0 age 60-63 super catch-up for this year/type (0 when none).
   * Present regardless of the filer's age so the UI can explain the rule.
   */
  superCatchUp?: number;
  /** Catch-up actually included in `total` (0 when the filer is too young). */
  catchUpApplied?: number;
  /** True when `catchUpApplied` came from the age 60-63 super catch-up. */
  superCatchUpApplied?: boolean;
}

/**
 * Apply the catch-up rules to an already-resolved base/catch-up row.
 *
 * Pure: the caller supplies the row, whether it came from the DB override
 * table or from `getDefaultLimits`. Split out of `getContributionLimit` so
 * the arithmetic stays reachable from the browser bundle.
 */
export function resolveContributionLimit(
  row: Pick<LimitDefaults, 'base_limit' | 'catch_up_limit' | 'catch_up_age'>,
  taxYear: number,
  accountType: string,
  birthday: string | null,
): ContributionLimitResult {
  const base = row.base_limit;
  const catchUp = row.catch_up_limit;
  const catchUpAge = row.catch_up_age;

  const superCatchUp = getSuperCatchUpLimit(taxYear, accountType);

  let total = base;
  let catchUpApplied = 0;
  let superCatchUpApplied = false;
  if (birthday) {
    const ageAtYearEnd = calculateAge(birthday, new Date(`${taxYear}-12-31`));
    if (ageAtYearEnd !== null && ageAtYearEnd >= catchUpAge) {
      // SECURE 2.0: ages 60-63 use the super catch-up INSTEAD of the ordinary
      // one (never both); 64+ reverts to the ordinary catch-up.
      const inSuperWindow =
        superCatchUp > 0 &&
        ageAtYearEnd >= SUPER_CATCH_UP_MIN_AGE &&
        ageAtYearEnd <= SUPER_CATCH_UP_MAX_AGE;
      superCatchUpApplied = inSuperWindow && superCatchUp > catchUp;
      catchUpApplied = superCatchUpApplied ? superCatchUp : catchUp;
      total = base + catchUpApplied;
    }
  }

  return { base, catchUp, total, catchUpAge, superCatchUp, catchUpApplied, superCatchUpApplied };
}
