import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ accountGuid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { accountGuid } = await params;

        const result = await prisma.$queryRaw<{
            last_balance: number | null;
            last_balance_date: Date | null;
        }[]>`
            SELECT last_balance, last_balance_date
            FROM gnucash_web_simplefin_account_map
            WHERE gnucash_account_guid = ${accountGuid}
              AND last_balance IS NOT NULL
            LIMIT 1
        `;

        if (result.length === 0) {
            return NextResponse.json({ hasBalance: false });
        }

        return NextResponse.json({
            hasBalance: true,
            balance: Number(result[0].last_balance),
            balanceDate: result[0].last_balance_date,
        });
    } catch (error) {
        console.error('Error fetching SimpleFin balance:', error);
        return NextResponse.json({ error: 'Failed to fetch balance' }, { status: 500 });
    }
}
