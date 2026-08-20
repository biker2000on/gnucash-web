import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { applyDocumentTagRules, APPLY_RULES_BATCH_SIZE } from '@/lib/documents/document-tags';

/**
 * POST /api/business/documents/tags/apply-rules[?afterId=<n>][&batchSize=<n>]
 *
 * Re-run deterministic auto-tag rules over a BOUNDED slice of the book's vault
 * documents (at most APPLY_RULES_BATCH_SIZE per request). The response carries
 * `{ processed, remaining, lastDocumentId }`; a client with `remaining > 0`
 * re-POSTs with `afterId=lastDocumentId` until it reaches zero. Per-document
 * failures are reported in `errors` rather than aborting the sweep.
 */
export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { searchParams } = new URL(request.url);
        const afterIdRaw = Number(searchParams.get('afterId') ?? 0);
        const batchSizeRaw = Number(searchParams.get('batchSize') ?? APPLY_RULES_BATCH_SIZE);

        const sweep = await applyDocumentTagRules(bookGuid, {
            afterId: Number.isFinite(afterIdRaw) ? Math.floor(afterIdRaw) : 0,
            batchSize: Number.isFinite(batchSizeRaw)
                ? Math.floor(batchSizeRaw)
                : APPLY_RULES_BATCH_SIZE,
        });

        return NextResponse.json({
            documents: sweep.results.map((row) => ({
                documentId: row.documentId,
                applied: row.applied,
            })),
            processed: sweep.processed,
            remaining: sweep.remaining,
            lastDocumentId: sweep.lastDocumentId,
            errors: sweep.errors,
        });
    } catch (error) {
        console.error('Error applying document tag rules:', error);
        return NextResponse.json({ error: 'Failed to apply tag rules' }, { status: 500 });
    }
}
