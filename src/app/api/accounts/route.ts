import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { Account, AccountWithChildren } from '@/lib/types';

/**
 * @openapi
 * /api/accounts:
 *   get:
 *     description: Returns the account hierarchy with total and period balances.
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
 *         description: A hierarchical list of accounts.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Account'
 */
export async function GET(request: NextRequest) {
    try {
        const searchParams = request.nextUrl.searchParams;
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');

        // Build dynamic query based on date filters
        const queryParams: (string | null)[] = [];
        let dateCondition = '';

        if (startDate || endDate) {
            if (startDate && endDate) {
                dateCondition = 't.post_date >= $1 AND t.post_date <= $2';
                queryParams.push(startDate, endDate);
            } else if (startDate) {
                dateCondition = 't.post_date >= $1';
                queryParams.push(startDate);
            } else if (endDate) {
                dateCondition = 't.post_date <= $1';
                queryParams.push(endDate);
            }
        }

        const accountQuery = `
      SELECT
        a.*,
        c.mnemonic as commodity_mnemonic,
        COALESCE(SUM(CAST(s.quantity_num AS NUMERIC) / CAST(s.quantity_denom AS NUMERIC)), 0) as total_balance,
        COALESCE(SUM(CASE WHEN ${dateCondition || '1=1'} THEN CAST(s.quantity_num AS NUMERIC) / CAST(s.quantity_denom AS NUMERIC) ELSE 0 END), 0) as period_balance
      FROM accounts a
      JOIN commodities c ON a.commodity_guid = c.guid
      LEFT JOIN splits s ON a.guid = s.account_guid
      LEFT JOIN transactions t ON s.tx_guid = t.guid
      GROUP BY a.guid, c.mnemonic
    `;

        const { rows } = await query(accountQuery, queryParams);
        const accounts: Account[] = rows.map(row => ({
            ...row,
            total_balance: parseFloat(row.total_balance).toFixed(2),
            period_balance: parseFloat(row.period_balance).toFixed(2)
        }));

        const accountMap: Record<string, AccountWithChildren> = {};
        const roots: AccountWithChildren[] = [];

        accounts.forEach(acc => {
            accountMap[acc.guid] = { ...acc, children: [] };
        });

        accounts.forEach(acc => {
            const node = accountMap[acc.guid];
            if (acc.parent_guid && accountMap[acc.parent_guid]) {
                accountMap[acc.parent_guid].children.push(node);
            } else {
                roots.push(node);
            }
        });

        // The user wants to display accounts starting 1 level under "Root Account"
        // and hide "Template Root" accounts.
        const rootNode = roots.find(r => r.name === 'Root Account' || r.account_type === 'ROOT' && !r.name.toLowerCase().includes('template'));

        if (rootNode) {
            return NextResponse.json(rootNode.children);
        }

        // Fallback: if no clear root is found, return roots that aren't system roots
        const filteredRoots = roots.filter(r =>
            r.account_type !== 'ROOT' &&
            !r.name.toLowerCase().includes('template root')
        );

        return NextResponse.json(filteredRoots);
    } catch (error) {
        console.error('Error fetching accounts:', error);
        return NextResponse.json({ error: 'Failed to fetch accounts' }, { status: 500 });
    }
}
