/**
 * Schedule F report generator — server-side SQL loader over the pure builder
 * in `schedule-f.ts`. Split from the pure module so the builder stays
 * client-safe (mirrors how generateScheduleC lives in business-reports.ts).
 */

import prisma from '@/lib/prisma';
import { buildScheduleF, type ScheduleFReport } from './schedule-f';

/**
 * Schedule F estimate for a tax year: sums INCOME/EXPENSE splits per account
 * and maps them onto Schedule F lines via keyword rules + overrides.
 *
 * `restrictToGuids` (optional) limits the account universe — used on
 * household books to scope the report to the farm subtrees pinned in the
 * Farm & Apiary Analyzer instead of the whole personal ledger.
 */
export async function generateScheduleF(
    bookAccountGuids: string[],
    year: number,
    overrides: Record<string, string> = {},
    restrictToGuids?: string[],
): Promise<ScheduleFReport> {
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));

    const restrict = restrictToGuids ? new Set(restrictToGuids) : null;
    const universe = restrict
        ? bookAccountGuids.filter((g) => restrict.has(g))
        : bookAccountGuids;
    if (universe.length === 0) {
        return buildScheduleF(year, [], overrides);
    }

    const rows = await prisma.$queryRaw<
        { guid: string; name: string; fullname: string; account_type: string; total: number }[]
    >`
        SELECT
            ah.guid,
            ah.name,
            ah.fullname,
            ah.account_type,
            SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)::float8 AS total
        FROM account_hierarchy ah
        JOIN splits s ON s.account_guid = ah.guid
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE ah.guid = ANY(${universe}::text[])
          AND ah.account_type IN ('INCOME', 'EXPENSE')
          AND t.post_date >= ${start} AND t.post_date <= ${end}
          -- Exclude value-only capital-gains offset splits so this report
          -- agrees with the farm analyzer's sums (see book-income.ts).
          AND NOT (s.quantity_num = 0 AND s.value_num <> 0)
        GROUP BY ah.guid, ah.name, ah.fullname, ah.account_type
    `;

    return buildScheduleF(
        year,
        rows.map((r) => ({
            guid: r.guid,
            name: r.name,
            path: r.fullname,
            type: r.account_type as 'INCOME' | 'EXPENSE',
            total: r.total,
        })),
        overrides,
    );
}
