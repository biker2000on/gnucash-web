import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';

interface SimpleFinMappingRow {
    gnucash_account_guid: string;
    last_sync_status: string | null;
    last_sync_error: string | null;
}

interface UnreviewedCountRow {
    account_guid: string;
    unreviewed_count: bigint;
}

export type ReviewStatusMap = {
    [accountGuid: string]: {
        hasSimpleFin: boolean;
        simpleFinSyncStatus: string | null;
        simpleFinSyncError: string | null;
        unreviewedCount: number;
    };
};

const SIMPLEFIN_STATUS_PRIORITY: Record<string, number> = {
    revoked: 5,
    failed: 4,
    running: 3,
    queued: 2,
    success: 1,
};

function emptyReviewStatus(): ReviewStatusMap[string] {
    return {
        hasSimpleFin: false,
        simpleFinSyncStatus: null,
        simpleFinSyncError: null,
        unreviewedCount: 0,
    };
}

export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        // Query 1: Accounts that have a SimpleFin mapping, including the
        // owning connection's health so account views can surface failures.
        const simpleFinMappings = await prisma.$queryRaw<SimpleFinMappingRow[]>`
            SELECT
                m.gnucash_account_guid,
                c.last_sync_status,
                c.last_sync_error
            FROM gnucash_web_simplefin_account_map m
            JOIN gnucash_web_simplefin_connections c ON c.id = m.connection_id
            WHERE m.gnucash_account_guid IS NOT NULL
              AND c.book_guid = ${bookGuid}
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
                statusMap[guid] = emptyReviewStatus();
            }
            const accountStatus = statusMap[guid];
            accountStatus.hasSimpleFin = true;

            const currentPriority = accountStatus.simpleFinSyncStatus
                ? SIMPLEFIN_STATUS_PRIORITY[accountStatus.simpleFinSyncStatus] ?? 0
                : 0;
            const nextPriority = row.last_sync_status
                ? SIMPLEFIN_STATUS_PRIORITY[row.last_sync_status] ?? 0
                : 0;
            if (nextPriority >= currentPriority) {
                accountStatus.simpleFinSyncStatus = row.last_sync_status;
                accountStatus.simpleFinSyncError = row.last_sync_error;
            }
        }

        for (const row of unreviewedCounts) {
            const guid = row.account_guid;
            if (!statusMap[guid]) {
                statusMap[guid] = emptyReviewStatus();
            }
            statusMap[guid].unreviewedCount = Number(row.unreviewed_count);
        }

        return NextResponse.json(statusMap);
    } catch (error) {
        console.error('Error fetching review status:', error);
        return NextResponse.json({ error: 'Failed to fetch review status' }, { status: 500 });
    }
}
