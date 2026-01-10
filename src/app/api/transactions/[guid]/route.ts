import { NextResponse } from 'next/server';
import { query, toDecimal } from '@/lib/db';

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
