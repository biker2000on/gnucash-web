import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';

interface SimpleFinMappingRow {
    gnucash_account_guid: string;
}

interface UnreviewedCountRow {
    account_guid: string;
    unreviewed_count: bigint;
}

export type ReviewStatusMap = {
    [accountGuid: string]: {
        hasSimpleFin: boolean;
        unreviewedCount: number;
    };
};

export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        // Query 1: Accounts that have a SimpleFin mapping
        const simpleFinMappings = await prisma.$queryRaw<SimpleFinMappingRow[]>`
            SELECT gnucash_account_guid
            FROM gnucash_web_simplefin_account_map
            WHERE gnucash_account_guid IS NOT NULL
        `;

        // Query 2: Unreviewed transaction counts per account
        const unreviewedCounts = await prisma.$queryRaw<UnreviewedCountRow[]>`
            SELECT s.account_guid, COUNT(DISTINCT m.transaction_guid) as unreviewed_count
            FROM gnucash_web_transaction_meta m
            JOIN splits s ON s.tx_guid = m.transaction_guid
            WHERE m.reviewed = false
              AND m.deleted_at IS NULL
              AND m.transaction_guid IS NOT NULL
            GROUP BY s.account_guid
        `;

        // Build the response map
        const statusMap: ReviewStatusMap = {};

        for (const row of simpleFinMappings) {
            const guid = row.gnucash_account_guid;
            if (!statusMap[guid]) {
                statusMap[guid] = { hasSimpleFin: false, unreviewedCount: 0 };
            }
            statusMap[guid].hasSimpleFin = true;
        }

        for (const row of unreviewedCounts) {
            const guid = row.account_guid;
            if (!statusMap[guid]) {
                statusMap[guid] = { hasSimpleFin: false, unreviewedCount: 0 };
            }
            statusMap[guid].unreviewedCount = Number(row.unreviewed_count);
        }

        return NextResponse.json(statusMap);
    } catch (error) {
        console.error('Error fetching review status:', error);
        return NextResponse.json({ error: 'Failed to fetch review status' }, { status: 500 });
    }
}
