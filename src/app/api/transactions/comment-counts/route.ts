import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { validationErrorResponse } from '@/lib/api-validation';
import {
    CommentAccessError,
    buildCommentContext,
    commentCountsForTransactions,
} from '@/lib/services/transaction-comments.service';

/** A ledger page is 50-200 rows; the cap is what one request may ask about. */
const MAX_GUIDS = 500;

/** GnuCash guids are exactly 32 lowercase hex characters — nothing else is one. */
const GUID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * POST /api/transactions/comment-counts
 * Body: `{ txnGuids: string[] }` → `{ counts: { [guid]: number } }`
 *
 * One batched call for a whole ledger/journal page. A POST rather than a GET
 * because a page of guids does not fit comfortably in a query string, and the
 * call is a pure read despite the verb.
 *
 * Only transactions with at least one comment appear in `counts`, so the
 * caller renders a badge exactly when the guid is present.
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const payload = await request.json().catch(() => null);
        const rawGuids = (payload as { txnGuids?: unknown } | null)?.txnGuids;
        if (!Array.isArray(rawGuids)) {
            return validationErrorResponse([{ path: ['txnGuids'], message: 'txnGuids must be an array of transaction guids' }]);
        }
        if (rawGuids.length > MAX_GUIDS) {
            return validationErrorResponse([{
                path: ['txnGuids'],
                message: `txnGuids may contain at most ${MAX_GUIDS} guids (received ${rawGuids.length})`,
            }]);
        }
        // Every element must be a guid before anything is queried. Silently
        // dropping the malformed ones would let a client send arbitrary
        // strings — including a 4000-character one — straight into the
        // `= ANY(…)` array, and answer 200 as though the request were fine.
        const malformed = rawGuids
            .map((guid, index) => ({ guid, index }))
            .filter(({ guid }) => typeof guid !== 'string' || !GUID_PATTERN.test(guid))
            .slice(0, 5);
        if (malformed.length > 0) {
            return validationErrorResponse(malformed.map(({ index }) => ({
                path: ['txnGuids', index],
                message: 'Each guid must be 32 lowercase hexadecimal characters',
            })));
        }
        const txnGuids = [...new Set(rawGuids as string[])];

        const context = await buildCommentContext(roleResult);
        // Scoped by book_root_guid alone: a guid from another book simply has
        // no rows here, so it comes back absent rather than leaking a count.
        return NextResponse.json({ counts: await commentCountsForTransactions(txnGuids, context) });
    } catch (error) {
        if (error instanceof CommentAccessError) return accessResponse(error);
        console.error('Error loading comment counts:', error);
        return NextResponse.json({ error: 'Failed to load comment counts' }, { status: 500 });
    }
}

function accessResponse(error: CommentAccessError): NextResponse {
    return NextResponse.json({ error: error.message }, { status: error.status });
}
