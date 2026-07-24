import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';
import { createCalculationTrace, persistCalculationTrace } from '@/lib/provenance';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        const { searchParams } = new URL(request.url);
        const asOfDate = searchParams.get('asOfDate');
        if (asOfDate) {
            const parsedAsOf = new Date(`${asOfDate}T00:00:00Z`);
            if (
                !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)
                || !Number.isFinite(parsedAsOf.getTime())
                || parsedAsOf.toISOString().slice(0, 10) !== asOfDate
            ) {
                return NextResponse.json(
                    { error: 'asOfDate must be a valid YYYY-MM-DD date' },
                    { status: 400 },
                );
            }
        }

        // Verify account belongs to active book
        const bookAccountGuids = await getAccountGuidsForBook(roleResult.bookGuid);
        if (!bookAccountGuids.includes(guid)) {
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

        const asOf = asOfDate || new Date().toISOString();
        const trace = createCalculationTrace({
            namespace: 'account-balance',
            identity: { bookGuid: roleResult.bookGuid, guid, asOfDate: asOfDate ?? 'current' },
            title: 'Account balance',
            summary: 'The sum of all split quantities posted to this account through the selected date.',
            asOfDate: asOf.slice(0, 10),
            formula: 'sum(split quantity numerator ÷ split quantity denominator)',
            result: Number(result[0].total_balance),
            unit: 'currency',
            evidence: [{
                kind: 'account',
                id: guid,
                label: 'GnuCash account splits',
                source: 'system',
                href: `/accounts/${guid}`,
                observedAt: new Date().toISOString(),
                verified: false,
            }],
            assumptions: ['The result is expressed in the account commodity; no market-price conversion is applied.'],
        });
        await persistCalculationTrace(roleResult.user.id, roleResult.bookGuid, trace);

        return NextResponse.json({
            guid,
            total_balance: result[0].total_balance,
            as_of: asOf,
            trace: { traceId: trace.id, href: `/api/provenance/${trace.id}` },
        });
    } catch (error) {
        console.error('Error fetching account balance:', error);
        return NextResponse.json({ error: 'Failed to fetch account balance' }, { status: 500 });
    }
}
