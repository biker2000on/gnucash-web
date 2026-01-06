import { NextResponse } from 'next/server';
import { query, toDecimal } from '@/lib/db';
import { Transaction, Split } from '@/lib/types';

/**
 * @openapi
 * /api/transactions:
 *   get:
 *     description: Returns a paginated list of transactions with their splits.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Number of transactions to return.
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of transactions to skip.
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search query to filter transactions by description, number, or account name.
 *     responses:
 *       200:
 *         description: A list of transactions.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Transaction'
 */
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const limit = parseInt(searchParams.get('limit') || '100');
        const offset = parseInt(searchParams.get('offset') || '0');
        const search = searchParams.get('search') || '';

        let txQuery = `
      SELECT t.guid, t.currency_guid, t.num, t.post_date, t.enter_date, t.description 
      FROM transactions t
    `;
        const queryParams: any[] = [limit, offset];

        if (search) {
            txQuery += `
        WHERE t.description ILIKE $3 
           OR t.num ILIKE $3 
           OR EXISTS (
             SELECT 1 FROM splits s 
             JOIN accounts a ON s.account_guid = a.guid 
             WHERE s.tx_guid = t.guid AND a.name ILIKE $3
           )
      `;
            queryParams.push(`%${search}%`);
        }

        txQuery += `
      ORDER BY t.post_date DESC 
      LIMIT $1 OFFSET $2
    `;
        const splitQuery = `
      SELECT s.*, a.name as account_name 
      FROM splits s
      JOIN accounts a ON s.account_guid = a.guid
      WHERE s.tx_guid = ANY($1)
    `;

        const txResult = await query(txQuery, queryParams);
        const transactions: Transaction[] = txResult.rows;

        const txGuids = transactions.map(tx => tx.guid);
        const splitResult = await query(splitQuery, [txGuids]);
        const splits: Split[] = splitResult.rows;

        const txMap: Record<string, Transaction> = {};
        transactions.forEach(tx => {
            txMap[tx.guid] = { ...tx, splits: [] };
        });

        splits.forEach(split => {
            if (txMap[split.tx_guid]) {
                const valueDecimal = toDecimal(split.value_num, split.value_denom);
                txMap[split.tx_guid].splits!.push({
                    ...split,
                    value_decimal: valueDecimal
                });
            }
        });

        return NextResponse.json(Object.values(txMap));
    } catch (error) {
        console.error('Error fetching transactions:', error);
        return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 });
    }
}
