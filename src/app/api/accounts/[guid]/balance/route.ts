import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { isAccountInActiveBook } from '@/lib/book-scope';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;
        const { searchParams } = new URL(request.url);
        const asOfDate = searchParams.get('asOfDate');

        // Verify account belongs to active book
        if (!await isAccountInActiveBook(guid)) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        let result;
        if (asOfDate) {
            result = await prisma.$queryRaw<[{ total_balance: string }]>`
                SELECT COALESCE(SUM(
                    CAST(s.quantity_num AS DECIMAL) / CAST(s.quantity_denom AS DECIMAL)
                ), 0)::text as total_balance
                FROM splits s
                JOIN transactions t ON s.tx_guid = t.guid
                WHERE s.account_guid = ${guid}
                AND t.post_date <= ${asOfDate}::timestamp
            `;
        } else {
            result = await prisma.$queryRaw<[{ total_balance: string }]>`
                SELECT COALESCE(SUM(
                    CAST(s.quantity_num AS DECIMAL) / CAST(s.quantity_denom AS DECIMAL)
                ), 0)::text as total_balance
                FROM splits s
                WHERE s.account_guid = ${guid}
            `;
        }

        return NextResponse.json({
            guid,
            total_balance: result[0].total_balance,
            as_of: asOfDate || new Date().toISOString(),
        });
    } catch (error) {
        console.error('Error fetching account balance:', error);
        return NextResponse.json({ error: 'Failed to fetch account balance' }, { status: 500 });
    }
}
