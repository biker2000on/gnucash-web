/**
 * Contribution Limit Coverage Service
 *
 * Detects tax years for which IRS contribution limits are not configured
 * (neither code defaults in irs-limits.ts nor DB overrides in
 * gnucash_web_contribution_limits) and raises notifications so a human can
 * enter the published numbers. The IRS has no API, so this is honest
 * automation: detect -> notify -> human fills in via /settings/limits.
 */

import prisma from '@/lib/prisma';
import { RETIREMENT_ACCOUNT_TYPES, getDefaultLimits } from '@/lib/reports/irs-limits';
import { createNotification, ensureNotificationsTable } from '@/lib/notifications';

/** Types with no federal annual contribution limit — never expected to have data. */
const NO_FEDERAL_LIMIT_TYPES = new Set(['brokerage', 'education_529']);

/** Earliest year present in the code defaults; used to bound scans. */
const EARLIEST_DEFAULT_YEAR = 2024;

export interface LimitCoverage {
  year: number;
  missingTypes: string[];
}

/**
 * Years whose coverage should be verified: always the current tax year, and
 * from November onward also the next year (the IRS publishes next-year
 * limits in late October / early November).
 */
export function yearsToCheck(now: Date = new Date()): number[] {
  const year = now.getFullYear();
  return now.getMonth() >= 10 ? [year, year + 1] : [year];
}

/**
 * Account types expected to have a configured limit: retirement account
 * types that appear in the code defaults for at least one known year.
 * This excludes types with no federal limit (brokerage, education_529) and
 * types the app has never tracked limits for (e.g. hra, which is
 * employer-set and absent from every DEFAULT_LIMITS year).
 */
export function getExpectedLimitTypes(now: Date = new Date()): string[] {
  const seenInDefaults = new Set<string>();
  for (let y = EARLIEST_DEFAULT_YEAR; y <= now.getFullYear() + 1; y++) {
    for (const d of getDefaultLimits(y)) {
      seenInDefaults.add(d.account_type);
    }
  }
  return RETIREMENT_ACCOUNT_TYPES.filter(
    t => !NO_FEDERAL_LIMIT_TYPES.has(t) && seenInDefaults.has(t)
  );
}

/** Pure helper: expected types minus those covered by defaults/overrides. */
export function computeMissingTypes(
  expectedTypes: string[],
  coveredTypes: Iterable<string>
): string[] {
  const covered = new Set(coveredTypes);
  return expectedTypes.filter(t => !covered.has(t));
}

/**
 * For each year to check, determine which expected account types have no
 * limit available from either code defaults or DB overrides.
 */
export async function checkLimitCoverage(now: Date = new Date()): Promise<LimitCoverage[]> {
  const expectedTypes = getExpectedLimitTypes(now);
  const results: LimitCoverage[] = [];

  for (const year of yearsToCheck(now)) {
    const overrides = await prisma.gnucash_web_contribution_limits.findMany({
      where: { tax_year: year },
      select: { account_type: true },
    });

    const covered = [
      ...getDefaultLimits(year).map(d => d.account_type),
      ...overrides.map(o => o.account_type),
    ];

    results.push({ year, missingTypes: computeMissingTypes(expectedTypes, covered) });
  }

  return results;
}

/**
 * Run the coverage check and create one notification per (user, year) for
 * years with missing limits. Deduped: skipped when an UNREAD notification
 * for the same year already exists for that user. Users with edit or admin
 * access to any book are notified (they can fix it at /settings/limits).
 */
export async function notifyMissingLimitCoverage(
  now: Date = new Date()
): Promise<{ checked: LimitCoverage[]; notified: number }> {
  const coverage = await checkLimitCoverage(now);
  const missingYears = coverage.filter(c => c.missingTypes.length > 0);
  if (missingYears.length === 0) return { checked: coverage, notified: 0 };

  const permissions = await prisma.gnucash_web_book_permissions.findMany({
    include: { role: true },
  });
  const userIds = [...new Set(
    permissions
      .filter(p => p.role.name === 'edit' || p.role.name === 'admin')
      .map(p => p.user_id)
  )];
  if (userIds.length === 0) return { checked: coverage, notified: 0 };

  await ensureNotificationsTable();

  let notified = 0;
  for (const { year, missingTypes } of missingYears) {
    const sourceId = `limit-coverage:${year}`;

    for (const userId of userIds) {
      const unread = await prisma.$queryRaw<Array<{ id: number }>>`
        SELECT id
        FROM gnucash_web_notifications
        WHERE user_id = ${userId}
          AND source = 'limit-coverage'
          AND source_id = ${sourceId}
          AND read_at IS NULL
        LIMIT 1
      `;
      if (unread.length > 0) continue;

      await createNotification({
        userId,
        type: 'contribution_limits',
        severity: 'warning',
        title: `IRS contribution limits for ${year} are not configured yet`,
        message: `No limit data for: ${missingTypes.join(', ')}. Enter the published IRS limits so contribution reports stay accurate.`,
        href: '/settings/limits',
        source: 'limit-coverage',
        sourceId,
      });
      notified++;
    }
  }

  return { checked: coverage, notified };
}
