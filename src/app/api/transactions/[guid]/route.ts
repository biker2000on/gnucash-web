import { NextResponse } from 'next/server';
import { query, toDecimal } from '@/lib/db';
import { Split, CreateTransactionRequest } from '@/lib/types';
import { generateGuid } from '@/lib/guid';
import { validateTransaction } from '@/lib/validation';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;

        // Fetch transaction
        const txResult = await query(
            `SELECT t.guid, t.currency_guid, t.num, t.post_date, t.enter_date, t.description
             FROM transactions t
             WHERE t.guid = $1`,
            [guid]
        );

        if (txResult.rows.length === 0) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        const transaction = txResult.rows[0];

        // Fetch splits with account info
        const splitResult = await query(
            `SELECT s.*, a.name as account_name, c.mnemonic as commodity_mnemonic
             FROM splits s
             JOIN accounts a ON s.account_guid = a.guid
             JOIN commodities c ON a.commodity_guid = c.guid
             WHERE s.tx_guid = $1
             ORDER BY s.value_num DESC`,
            [guid]
        );

        const splits = splitResult.rows.map(split => ({
            ...split,
            value_decimal: toDecimal(split.value_num, split.value_denom),
            quantity_decimal: toDecimal(split.quantity_num, split.quantity_denom),
        }));

        return NextResponse.json({
            ...transaction,
            splits,
        });
    } catch (error) {
        console.error('Error fetching transaction:', error);
        return NextResponse.json({ error: 'Failed to fetch transaction' }, { status: 500 });
    }
}

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;
        const body: CreateTransactionRequest = await request.json();

        // Validate the transaction
        const validation = validateTransaction(body);
        if (!validation.valid) {
            return NextResponse.json({ errors: validation.errors }, { status: 400 });
        }

        // Verify transaction exists
        const existingTx = await query(
            'SELECT guid FROM transactions WHERE guid = $1',
            [guid]
        );
        if (existingTx.rows.length === 0) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
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

        // Update transaction
        await query(
            `UPDATE transactions
             SET currency_guid = $2, num = $3, post_date = $4, description = $5
             WHERE guid = $1`,
            [guid, body.currency_guid, body.num || '', body.post_date, body.description]
        );

        // Delete existing splits and recreate
        await query('DELETE FROM splits WHERE tx_guid = $1', [guid]);

        // Insert new splits
        for (const split of body.splits) {
            const splitGuid = generateGuid();
            await query(
                `INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                    splitGuid,
                    guid,
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

        // Return the updated transaction
        const txResult = await query(
            `SELECT t.guid, t.currency_guid, t.num, t.post_date, t.enter_date, t.description
             FROM transactions t WHERE t.guid = $1`,
            [guid]
        );

        const splitResult = await query(
            `SELECT s.*, a.name as account_name, c.mnemonic as commodity_mnemonic
             FROM splits s
             JOIN accounts a ON s.account_guid = a.guid
             JOIN commodities c ON a.commodity_guid = c.guid
             WHERE s.tx_guid = $1
             ORDER BY s.value_num DESC`,
            [guid]
        );

        const transaction = txResult.rows[0];
        transaction.splits = splitResult.rows.map((split: Split) => ({
            ...split,
            value_decimal: toDecimal(split.value_num, split.value_denom),
            quantity_decimal: toDecimal(split.quantity_num, split.quantity_denom),
        }));

        return NextResponse.json(transaction);
    } catch (error) {
        console.error('Error updating transaction:', error);
        return NextResponse.json({ error: 'Failed to update transaction' }, { status: 500 });
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;

        // Verify transaction exists
        const existingTx = await query(
            'SELECT guid FROM transactions WHERE guid = $1',
            [guid]
        );
        if (existingTx.rows.length === 0) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        // Delete splits first (foreign key constraint)
        await query('DELETE FROM splits WHERE tx_guid = $1', [guid]);

        // Delete transaction
        await query('DELETE FROM transactions WHERE guid = $1', [guid]);

        return NextResponse.json({ success: true, deleted: guid });
    } catch (error) {
        console.error('Error deleting transaction:', error);
        return NextResponse.json({ error: 'Failed to delete transaction' }, { status: 500 });
    }
}
