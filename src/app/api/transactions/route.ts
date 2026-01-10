import { NextResponse } from 'next/server';
import { query, toDecimal } from '@/lib/db';
import { Transaction, Split, CreateTransactionRequest } from '@/lib/types';
import { generateGuid } from '@/lib/guid';
import { validateTransaction } from '@/lib/validation';

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

/**
 * @openapi
 * /api/transactions:
 *   post:
 *     description: Create a new transaction with splits.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateTransactionRequest'
 *     responses:
 *       201:
 *         description: Transaction created successfully.
 *       400:
 *         description: Validation error.
 *       500:
 *         description: Server error.
 */
export async function POST(request: Request) {
    try {
        const body: CreateTransactionRequest = await request.json();

        // Validate the transaction
        const validation = validateTransaction(body);
        if (!validation.valid) {
            return NextResponse.json({ errors: validation.errors }, { status: 400 });
        }

        // Verify all account GUIDs exist
        const accountGuids = body.splits.map(s => s.account_guid);
        const accountCheck = await query(
            'SELECT guid FROM accounts WHERE guid = ANY($1)',
            [accountGuids]
        );
        if (accountCheck.rows.length !== accountGuids.length) {
            const foundGuids = new Set(accountCheck.rows.map((r: { guid: string }) => r.guid));
            const missingGuids = accountGuids.filter(g => !foundGuids.has(g));
            return NextResponse.json({
                errors: [{ field: 'splits', message: `Invalid account GUIDs: ${missingGuids.join(', ')}` }]
            }, { status: 400 });
        }

        // Generate GUIDs
        const txGuid = generateGuid();
        const now = new Date().toISOString();

        // Insert transaction
        await query(
            `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [txGuid, body.currency_guid, body.num || '', body.post_date, now, body.description]
        );

        // Insert splits
        for (const split of body.splits) {
            const splitGuid = generateGuid();
            await query(
                `INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                    splitGuid,
                    txGuid,
                    split.account_guid,
                    split.memo || '',
                    split.action || '',
                    split.reconcile_state || 'n',
                    null,
                    split.value_num,
                    split.value_denom,
                    split.quantity_num ?? split.value_num,
                    split.quantity_denom ?? split.value_denom,
                    null
                ]
            );
        }

        // Return the created transaction
        const txResult = await query(
            `SELECT t.guid, t.currency_guid, t.num, t.post_date, t.enter_date, t.description
             FROM transactions t WHERE t.guid = $1`,
            [txGuid]
        );

        const splitResult = await query(
            `SELECT s.*, a.name as account_name, c.mnemonic as commodity_mnemonic
             FROM splits s
             JOIN accounts a ON s.account_guid = a.guid
             JOIN commodities c ON a.commodity_guid = c.guid
             WHERE s.tx_guid = $1`,
            [txGuid]
        );

        const transaction = txResult.rows[0];
        transaction.splits = splitResult.rows.map((split: Split) => ({
            ...split,
            value_decimal: toDecimal(split.value_num, split.value_denom),
            quantity_decimal: toDecimal(split.quantity_num, split.quantity_denom),
        }));

        return NextResponse.json(transaction, { status: 201 });
    } catch (error) {
        console.error('Error creating transaction:', error);
        return NextResponse.json({ error: 'Failed to create transaction' }, { status: 500 });
    }
}
