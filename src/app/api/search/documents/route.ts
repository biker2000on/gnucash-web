import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { searchDocuments, validateSearchQuery, MAX_GROUP_RESULTS } from '@/lib/doc-search';

/**
 * GET /api/search/documents?q=<query>[&limit=<n>]
 *
 * Read-only, book-scoped full-text search across receipts (OCR text),
 * statement lines, payslips, and transaction descriptions/memos.
 * Minimum 3-character query; at most 20 hits per group.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const validation = validateSearchQuery(searchParams.get('q'));
        if (!validation.ok) {
            return NextResponse.json({ error: validation.error }, { status: 400 });
        }

        const rawLimit = Number(searchParams.get('limit') ?? MAX_GROUP_RESULTS);
        const limit = Number.isFinite(rawLimit)
            ? Math.min(Math.max(1, Math.floor(rawLimit)), MAX_GROUP_RESULTS)
            : MAX_GROUP_RESULTS;

        const bookAccountGuids = await getBookAccountGuids();
        const results = await searchDocuments(
            bookAccountGuids,
            roleResult.bookGuid,
            validation.query,
            { limit },
        );

        return NextResponse.json(results);
    } catch (error) {
        console.error('Error searching documents:', error);
        return NextResponse.json({ error: 'Failed to search documents' }, { status: 500 });
    }
}
