import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { applyDocumentTagRules } from '@/lib/documents/document-tags';

/**
 * POST /api/business/documents/tags/apply-rules
 *
 * Re-run deterministic auto-tag rules for every vault document in the book.
 * Returns per-document counts of newly applied tags.
 */
export async function POST() {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const results = await applyDocumentTagRules(bookGuid);
        return NextResponse.json({
            documents: results.map((row) => ({
                documentId: row.documentId,
                applied: row.applied,
            })),
        });
    } catch (error) {
        console.error('Error applying document tag rules:', error);
        return NextResponse.json({ error: 'Failed to apply tag rules' }, { status: 500 });
    }
}
