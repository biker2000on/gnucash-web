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
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter transactions on or after this date (ISO 8601).
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter transactions on or before this date (ISO 8601).
 *       - in: query
 *         name: accountTypes
 *         schema:
 *           type: string
 *         description: Comma-separated list of account types to filter by (e.g., ASSET,EXPENSE).
 *       - in: query
 *         name: minAmount
 *         schema:
 *           type: number
 *         description: Minimum absolute transaction amount.
 *       - in: query
 *         name: maxAmount
 *         schema:
 *           type: number
 *         description: Maximum absolute transaction amount.
 *       - in: query
 *         name: reconcileStates
 *         schema:
 *           type: string
 *         description: Comma-separated reconciliation states (n=not reconciled, c=cleared, y=reconciled).
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
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');
        const accountTypes = searchParams.get('accountTypes');
        const minAmount = searchParams.get('minAmount');
        const maxAmount = searchParams.get('maxAmount');
        const reconcileStates = searchParams.get('reconcileStates');

        const conditions: string[] = [];
        const queryParams: any[] = [limit, offset];
        let paramIndex = 3;

        // Date filters
        if (startDate) {
            conditions.push(`t.post_date >= $${paramIndex}`);
            queryParams.push(startDate);
            paramIndex++;
        }
        if (endDate) {
            conditions.push(`t.post_date <= $${paramIndex}`);
            queryParams.push(endDate);
            paramIndex++;
        }

        // Search filter
        if (search) {
            conditions.push(`(
                t.description ILIKE $${paramIndex}
                OR t.num ILIKE $${paramIndex}
                OR EXISTS (
                    SELECT 1 FROM splits s
                    JOIN accounts a ON s.account_guid = a.guid
                    WHERE s.tx_guid = t.guid AND a.name ILIKE $${paramIndex}
                )
            )`);
            queryParams.push(`%${search}%`);
            paramIndex++;
        }

        // Account type filter
        if (accountTypes) {
            const types = accountTypes.split(',').map(t => t.trim().toUpperCase());
            conditions.push(`EXISTS (
                SELECT 1 FROM splits s
                JOIN accounts a ON s.account_guid = a.guid
                WHERE s.tx_guid = t.guid AND a.account_type = ANY($${paramIndex})
            )`);
            queryParams.push(types);
            paramIndex++;
        }

        // Amount range filters (on any split in the transaction)
        if (minAmount) {
            conditions.push(`EXISTS (
                SELECT 1 FROM splits s
                WHERE s.tx_guid = t.guid
                AND ABS(CAST(s.value_num AS NUMERIC) / CAST(s.value_denom AS NUMERIC)) >= $${paramIndex}
            )`);
            queryParams.push(parseFloat(minAmount));
            paramIndex++;
        }
        if (maxAmount) {
            conditions.push(`EXISTS (
                SELECT 1 FROM splits s
                WHERE s.tx_guid = t.guid
                AND ABS(CAST(s.value_num AS NUMERIC) / CAST(s.value_denom AS NUMERIC)) <= $${paramIndex}
            )`);
            queryParams.push(parseFloat(maxAmount));
            paramIndex++;
        }

        // Reconciliation state filter
        if (reconcileStates) {
            const states = reconcileStates.split(',').map(s => s.trim().toLowerCase());
            conditions.push(`EXISTS (
                SELECT 1 FROM splits s
                WHERE s.tx_guid = t.guid AND s.reconcile_state = ANY($${paramIndex})
            )`);
            queryParams.push(states);
            paramIndex++;
        }

        let txQuery = `
      SELECT t.guid, t.currency_guid, t.num, t.post_date, t.enter_date, t.description
      FROM transactions t
    `;

        if (conditions.length > 0) {
            txQuery += ` WHERE ${conditions.join(' AND ')}`;
        }

        txQuery += `
      ORDER BY t.post_date DESC
      LIMIT $1 OFFSET $2
    `;
        const splitQuery = `
      SELECT s.*, a.name as account_name, c.mnemonic as commodity_mnemonic 
      FROM splits s
      JOIN accounts a ON s.account_guid = a.guid
      JOIN commodities c ON a.commodity_guid = c.guid
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
                const quantityDecimal = toDecimal(split.quantity_num, split.quantity_denom);
                txMap[split.tx_guid].splits!.push({
                    ...split,
                    value_decimal: valueDecimal,
                    quantity_decimal: quantityDecimal
                });
            }
        });

        return NextResponse.json(Object.values(txMap));
    } catch (error) {
        console.error('Error fetching transactions:', error);
        return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 });
    }
}
