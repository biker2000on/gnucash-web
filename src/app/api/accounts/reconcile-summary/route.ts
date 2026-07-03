import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

interface ReconcileSummaryQueryResult {
    account_guid: string;
    account_type: string;
    commodity_guid: string | null;
    commodity_namespace: string | null;
    last_reconcile_date: Date | null;
    reconciled_balance: string | null;
}

interface AccountReconcileSummary {
    guid: string;
    last_reconcile_date: string | null;
    reconciled_usd: string;
    reconciled_quantity: string;
    is_investment: boolean;
}

export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const bookAccountGuids = await getBookAccountGuids();

        const results = await prisma.$queryRaw<ReconcileSummaryQueryResult[]>`
            SELECT
                a.guid as account_guid,
                a.account_type,
                a.commodity_guid,
                c.namespace as commodity_namespace,
                MAX(
                    CASE
                        WHEN s.reconcile_state = 'y' AND s.reconcile_date IS NOT NULL
                        THEN s.reconcile_date
                        ELSE NULL
                    END
                ) as last_reconcile_date,
                SUM(
                    CASE
                        WHEN s.reconcile_state = 'y'
                        THEN CAST(s.quantity_num AS DECIMAL) / CAST(s.quantity_denom AS DECIMAL)
                        ELSE 0
                    END
                )::text as reconciled_balance
            FROM accounts a
            LEFT JOIN splits s ON s.account_guid = a.guid
            LEFT JOIN commodities c ON a.commodity_guid = c.guid
            WHERE a.guid = ANY(${bookAccountGuids}::text[])
            GROUP BY a.guid, a.account_type, a.commodity_guid, c.namespace
        `;

        const investmentTypes = ['STOCK', 'MUTUAL'];
        const priceCache = new Map<string, number>();

        // Bulk-fetch the latest price per investment commodity in a single query.
        // Mirrors getLatestPrice() semantics: date <= now, value_num > 0 (GnuCash's
        // split register records implied $0 prices for zero-value transfers; never
        // value holdings with them), no currency filter, latest date wins.
        const investmentCommodityGuids = [
            ...new Set(
                results
                    .filter(
                        (r) =>
                            investmentTypes.includes(r.account_type) &&
                            r.commodity_guid &&
                            r.commodity_namespace !== 'CURRENCY'
                    )
                    .map((r) => r.commodity_guid as string)
            ),
        ];

        if (investmentCommodityGuids.length > 0) {
            const priceRows = await prisma.$queryRaw<{
                commodity_guid: string;
                value_num: bigint;
                value_denom: bigint;
            }[]>`
                SELECT DISTINCT ON (commodity_guid)
                    commodity_guid, value_num, value_denom
                FROM prices
                WHERE commodity_guid = ANY(${investmentCommodityGuids}::text[])
                  AND date <= ${new Date()}
                  AND value_num > 0
                ORDER BY commodity_guid, date DESC
            `;
            for (const row of priceRows) {
                priceCache.set(row.commodity_guid, toDecimalNumber(row.value_num, row.value_denom));
            }
        }

        const summaries: AccountReconcileSummary[] = results.map((result) => {
            const reconciledBalance = parseFloat(result.reconciled_balance || '0');
            const isInvestment =
                investmentTypes.includes(result.account_type) &&
                result.commodity_guid &&
                result.commodity_namespace !== 'CURRENCY';

            const reconciledUsd =
                isInvestment && result.commodity_guid
                    ? reconciledBalance * (priceCache.get(result.commodity_guid) || 0)
                    : reconciledBalance;

            return {
                guid: result.account_guid,
                last_reconcile_date: result.last_reconcile_date
                    ? result.last_reconcile_date.toISOString().slice(0, 10)
                    : null,
                reconciled_usd: reconciledUsd.toFixed(2),
                reconciled_quantity: reconciledBalance.toString(),
                is_investment: Boolean(isInvestment),
            };
        });

        return NextResponse.json(summaries);
    } catch (error) {
        console.error('Error fetching account reconcile summary:', error);
        return NextResponse.json({ error: 'Failed to fetch account reconcile summary' }, { status: 500 });
    }
}
