import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { Account, AccountWithChildren } from '@/lib/types';

export async function GET() {
    try {
        const periodStartDate = '2026-01-01';

        const accountQuery = `
      SELECT 
        a.*,
        COALESCE(SUM(CAST(s.value_num AS NUMERIC) / CAST(s.value_denom AS NUMERIC)), 0) as total_balance,
        COALESCE(SUM(CASE WHEN t.post_date >= $1 THEN CAST(s.value_num AS NUMERIC) / CAST(s.value_denom AS NUMERIC) ELSE 0 END), 0) as period_balance
      FROM accounts a
      LEFT JOIN splits s ON a.guid = s.account_guid
      LEFT JOIN transactions t ON s.tx_guid = t.guid
      GROUP BY a.guid
    `;

        const { rows } = await query(accountQuery, [periodStartDate]);
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

        return NextResponse.json(roots);
    } catch (error) {
        console.error('Error fetching accounts:', error);
        return NextResponse.json({ error: 'Failed to fetch accounts' }, { status: 500 });
    }
}
