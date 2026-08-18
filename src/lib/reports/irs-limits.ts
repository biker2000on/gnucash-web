/**
 * Server-only IRS limit resolvers: the DB-override lookups layered over the
 * statutory tables in `./irs-limit-tables`.
 *
 * This module imports prisma, so it must never be reachable from a Client
 * Component. Anything that only needs the tables or the pure arithmetic should
 * import `@/lib/reports/irs-limit-tables` directly — see the
 * client-bundle guard in `src/__tests__/client-bundle-prisma.test.ts`.
 *
 * The pure surface is re-exported below so existing server call sites keep
 * importing everything from here.
 */

import prisma from '@/lib/prisma';
import {
  NO_FEDERAL_LIMIT_TYPES,
  NEC_THRESHOLD_OVERRIDE_ACCOUNT_TYPE,
  getDefaultNecThreshold,
  getDefaultLimits,
  resolveContributionLimit,
  type ContributionLimitResult,
  type LimitDefaults,
} from './irs-limit-tables';

export {
  RETIREMENT_ACCOUNT_TYPES,
  NO_FEDERAL_LIMIT_TYPES,
  NEC_THRESHOLD_OVERRIDE_ACCOUNT_TYPE,
  getDefaultNecThreshold,
  getDefaultLimits,
  getSuperCatchUpLimit,
  calculateAge,
  resolveContributionLimit,
} from './irs-limit-tables';
export type {
  RetirementAccountType,
  LimitDefaults,
  ContributionLimitResult,
} from './irs-limit-tables';

/**
 * Resolve the year's 1099-NEC threshold. A deliberate DB override wins;
 * unknown years return null rather than guessing an inflation adjustment.
 */
export async function getNecThreshold(taxYear: number): Promise<number | null> {
  const override = await prisma.gnucash_web_contribution_limits.findFirst({
    where: { tax_year: taxYear, account_type: NEC_THRESHOLD_OVERRIDE_ACCOUNT_TYPE },
  });
  if (override && Number.isFinite(Number(override.base_limit)) && Number(override.base_limit) > 0) {
    return Number(override.base_limit);
  }
  return getDefaultNecThreshold(taxYear);
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

  let row: Pick<LimitDefaults, 'base_limit' | 'catch_up_limit' | 'catch_up_age'>;

  if (dbLimit) {
    row = {
      base_limit: Number(dbLimit.base_limit),
      catch_up_limit: Number(dbLimit.catch_up_limit),
      catch_up_age: dbLimit.catch_up_age,
    };
  } else {
    const defaults = getDefaultLimits(taxYear);
    const match = defaults.find(d => d.account_type === accountType);
    if (!match) return null;
    row = match;
  }

  return resolveContributionLimit(row, taxYear, accountType, birthday);
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
