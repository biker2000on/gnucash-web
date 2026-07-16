import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { previewSettlementImport } from '@/lib/import/settlement-import.service';
import { readSettlementUpload, resolveSettlementContext, settlementErrorResponse } from '../shared';

/**
 * POST /api/import-export/settlements/preview
 *
 * Multipart form data:
 *   file           — the processor payout/transactions CSV export
 *   source         — 'stripe' | 'square' | 'paypal' | 'shopify'
 *   locale         — 'us' (default) | 'eu' (day-first dates, comma decimals)
 *   mappings       — JSON { income?, fees?, clearing?, bank?: guid | 'new' }
 *   skipDuplicates — 'true' (default) | 'false'
 *
 * Returns the parsed preview (no writes): per-kind counts, gross/fee/net
 * totals, the clearing-balance projection, resolved target accounts, and
 * duplicate/period-lock skip counts. Requires the edit role.
 */
export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const upload = await readSettlementUpload(request);
        if (upload instanceof NextResponse) return upload;

        const ctx = await resolveSettlementContext(roleResult.bookGuid);
        const preview = await previewSettlementImport(upload.source, upload.input, ctx);
        return NextResponse.json(preview);
    } catch (error) {
        return settlementErrorResponse('preview', error);
    }
}
