/**
 * Schedule F report generator — server-side SQL loader over the pure builder
 * in `schedule-f.ts`. Split from the pure module so the builder stays
 * client-safe (mirrors how generateScheduleC lives in business-reports.ts).
 */

import prisma from '@/lib/prisma';
import { buildScheduleF, type ScheduleFReport } from './schedule-f';
import { sumFarmSplitsInBookCurrency } from '@/lib/tax/farm-currency';

export interface ScheduleFGenerationResult extends ScheduleFReport {
    currencyCode: string;
    convertedCurrencies: string[];
}

/**
 * Schedule F estimate for a tax year: sums INCOME/EXPENSE splits per account
 * and maps them onto Schedule F lines via keyword rules + overrides.
 *
 * `restrictToGuids` (optional) limits the account universe — used on
 * household books to scope the report to the farm subtrees pinned in the
 * Farm & Apiary Analyzer instead of the whole personal ledger.
 */
export async function generateScheduleF(
    bookGuid: string,
    bookAccountGuids: string[],
    year: number,
    overrides: Record<string, string> = {},
    restrictToGuids?: string[],
): Promise<ScheduleFGenerationResult> {
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));

    const restrict = restrictToGuids ? new Set(restrictToGuids) : null;
    const universe = restrict
        ? bookAccountGuids.filter((g) => restrict.has(g))
        : bookAccountGuids;
    const accounts = await prisma.$queryRaw<
        { guid: string; name: string; fullname: string; account_type: string }[]
    >`
        SELECT guid, name, fullname, account_type
        FROM account_hierarchy
        WHERE guid = ANY(${universe}::text[])
          AND account_type IN ('INCOME', 'EXPENSE')
    `;
    const sums = await sumFarmSplitsInBookCurrency(
        bookGuid,
        accounts.map((account) => account.guid),
        start,
        end,
    );
    const totalByGuid = new Map(sums.totals.map((row) => [row.accountGuid, row.total]));

    return {
        ...buildScheduleF(
            year,
            accounts.map((r) => ({
            guid: r.guid,
            name: r.name,
            path: r.fullname,
            type: r.account_type as 'INCOME' | 'EXPENSE',
            total: totalByGuid.get(r.guid) ?? 0,
            })),
            overrides,
        ),
        currencyCode: sums.currencyCode,
        convertedCurrencies: sums.convertedCurrencies,
    };
}
