import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { commitSettlementImport } from '@/lib/import/settlement-import.service';
import { readSettlementUpload, resolveSettlementContext, settlementErrorResponse } from '../shared';

/**
 * POST /api/import-export/settlements/commit
 *
 * Same multipart fields as preview. Creates the mapped accounts and the
 * gross/fee/net settlement transactions in the ACTIVE book, stamping
 * transactions.num with '<source>:<reference>' for duplicate detection,
 * skipping already-imported and period-locked rows, then records a
 * gnucash_web_import_batches row with source 'settlement_<source>'.
 */
export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { user } = roleResult;

        const upload = await readSettlementUpload(request);
        if (upload instanceof NextResponse) return upload;

        const ctx = await resolveSettlementContext(roleResult.bookGuid);
        const result = await commitSettlementImport(user.id, upload.source, upload.input, ctx);
        return NextResponse.json({ success: true, ...result });
    } catch (error) {
        return settlementErrorResponse('commit', error);
    }
}
