import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { serializeBigInts } from '@/lib/gnucash';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;

        // Verify account belongs to active book
        if (!await isAccountInActiveBook(guid)) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        // The account_hierarchy view is created by db-init.ts
        // We need to use raw SQL since it's a view, not a Prisma model
        const result = await prisma.$queryRaw<Array<{
            name: string;
            fullname: string | null;
            account_type: string;
            commodity_guid: string | null;
            commodity_namespace: string | null;
            commodity_mnemonic: string | null;
            guid1: string | null;
            guid2: string | null;
            guid3: string | null;
            guid4: string | null;
            guid5: string | null;
            guid6: string | null;
            level1: string | null;
            level2: string | null;
            level3: string | null;
            level4: string | null;
            level5: string | null;
            level6: string | null;
            depth: number | null;
        }>>`
            SELECT
                a.name,
                ah.fullname,
                a.account_type,
                a.commodity_guid,
                c.namespace as commodity_namespace,
                c.mnemonic as commodity_mnemonic,
                ah.guid1, ah.guid2, ah.guid3, ah.guid4, ah.guid5, ah.guid6,
                ah.level1, ah.level2, ah.level3, ah.level4, ah.level5, ah.level6,
                ah.depth
            FROM accounts a
            LEFT JOIN account_hierarchy ah ON a.guid = ah.guid
            LEFT JOIN commodities c ON a.commodity_guid = c.guid
            WHERE a.guid = ${guid}
        `;

        if (result.length === 0) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        return NextResponse.json(serializeBigInts(result[0]));
    } catch (error) {
        console.error('Error fetching account info:', error);
        return NextResponse.json({ error: 'Failed to fetch account info' }, { status: 500 });
    }
}
