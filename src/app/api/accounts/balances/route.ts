import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { serializeBigInts } from '@/lib/gnucash';
import { getLatestPrice } from '@/lib/commodities';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

interface AccountBalance {
    guid: string;
    total_balance: string;
    period_balance: string;
    total_balance_usd?: string;
    period_balance_usd?: string;
}

interface BalanceQueryResult {
    account_guid: string;
    account_type: string;
    commodity_guid: string | null;
    commodity_namespace: string | null;
    commodity_mnemonic: string | null;
    total_balance: string;
    period_balance: string;
}

/**
 * @openapi
 * /api/accounts/balances:
 *   get:
 *     description: Returns optimized balance data for all accounts.
 *     parameters:
 *       - name: startDate
 *         in: query
 *         description: Start date for period balance calculation (ISO 8601)
 *         schema:
 *           type: string
 *           format: date
 *       - name: endDate
 *         in: query
 *         description: End date for period balance calculation (ISO 8601)
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: Array of account balances.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   guid:
 *                     type: string
 *                   total_balance:
 *                     type: string
 *                   period_balance:
 *                     type: string
 *                   total_balance_usd:
 *                     type: string
 *                   period_balance_usd:
 *                     type: string
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const searchParams = request.nextUrl.searchParams;
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');

        // Get book account GUIDs for scoping
        const bookAccountGuids = await getBookAccountGuids();

        // Build the SQL query with aggregation, scoped to active book
        const results = await prisma.$queryRaw<BalanceQueryResult[]>`
            SELECT
                s.account_guid,
                a.account_type,
                a.commodity_guid,
                c.namespace as commodity_namespace,
                c.mnemonic as commodity_mnemonic,
                SUM(CAST(s.quantity_num AS DECIMAL) / CAST(s.quantity_denom AS DECIMAL))::text as total_balance,
                SUM(
                    CASE
                        WHEN t.post_date >= ${startDate ? new Date(startDate) : new Date('1970-01-01')}::date
                         AND t.post_date <= ${endDate ? new Date(endDate) : new Date('2100-12-31')}::date
                        THEN CAST(s.quantity_num AS DECIMAL) / CAST(s.quantity_denom AS DECIMAL)
                        ELSE 0
                    END
                )::text as period_balance
            FROM splits s
            JOIN transactions t ON s.tx_guid = t.guid
            JOIN accounts a ON s.account_guid = a.guid
            LEFT JOIN commodities c ON a.commodity_guid = c.guid
            WHERE s.account_guid = ANY(${bookAccountGuids}::text[])
            GROUP BY s.account_guid, a.account_type, a.commodity_guid, c.namespace, c.mnemonic
        `;

        // Identify investment accounts and fetch prices
        const investmentTypes = ['STOCK', 'MUTUAL'];
        const priceCache = new Map<string, number>();

        for (const result of results) {
            const isInvestment =
                investmentTypes.includes(result.account_type) &&
                result.commodity_guid &&
                result.commodity_namespace !== 'CURRENCY';

            if (isInvestment && result.commodity_guid) {
                if (!priceCache.has(result.commodity_guid)) {
                    const price = await getLatestPrice(result.commodity_guid);
                    priceCache.set(result.commodity_guid, price?.value || 0);
                }
            }
        }

        // Build response with USD calculations for investments
        const balances: AccountBalance[] = results.map(result => {
            const isInvestment =
                investmentTypes.includes(result.account_type) &&
                result.commodity_guid &&
                result.commodity_namespace !== 'CURRENCY';

            const totalBalance = parseFloat(result.total_balance);
            const periodBalance = parseFloat(result.period_balance);

            const balance: AccountBalance = {
                guid: result.account_guid,
                total_balance: totalBalance.toFixed(2),
                period_balance: periodBalance.toFixed(2),
            };

            if (isInvestment && result.commodity_guid) {
                const pricePerShare = priceCache.get(result.commodity_guid) || 0;
                balance.total_balance_usd = (totalBalance * pricePerShare).toFixed(2);
                balance.period_balance_usd = (periodBalance * pricePerShare).toFixed(2);
            }

            return balance;
        });

        return NextResponse.json(serializeBigInts(balances));
    } catch (error) {
        console.error('Error fetching account balances:', error);
        return NextResponse.json({ error: 'Failed to fetch account balances' }, { status: 500 });
    }
}
