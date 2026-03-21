import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getLatestPrice } from '@/lib/commodities';
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

        for (const result of results) {
            const isInvestment =
                investmentTypes.includes(result.account_type) &&
                result.commodity_guid &&
                result.commodity_namespace !== 'CURRENCY';

            if (isInvestment && result.commodity_guid && !priceCache.has(result.commodity_guid)) {
                const price = await getLatestPrice(result.commodity_guid);
                priceCache.set(result.commodity_guid, price?.value || 0);
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
            };
        });

        return NextResponse.json(summaries);
    } catch (error) {
        console.error('Error fetching account reconcile summary:', error);
        return NextResponse.json({ error: 'Failed to fetch account reconcile summary' }, { status: 500 });
    }
}
