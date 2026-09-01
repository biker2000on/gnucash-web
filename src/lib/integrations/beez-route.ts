/**
 * HTTP shell shared by every /api/integrations/beez/* route.
 *
 * The routes are thin on purpose: authenticate, parse, call
 * src/lib/services/beez-sync.service.ts, translate the outcome. Keeping the
 * translation in one place is what stops the five endpoints from drifting into
 * five different spellings of the same 404.
 */

import { NextResponse } from 'next/server';
import { requireRole, type Role } from '@/lib/auth';
import { PeriodLockedError, periodLockedResponse } from '@/lib/services/period-lock.service';
import {
    BeezSyncError,
    getBeezBookContext,
    type BeezBookContext,
} from '@/lib/services/beez-sync.service';
import {
    IDEMPOTENCY_KEY_MAX_LENGTH,
    validateIdempotencyKey,
} from '@/lib/webhook-idempotency';
import { normalizeExternalId } from '@/lib/integrations/beez';

export { IDEMPOTENCY_KEY_MAX_LENGTH };

export interface BeezRequestContext {
    context: BeezBookContext;
    actor: { userId: number };
}

/**
 * Authenticate and resolve the book, or return the response to send.
 *
 * The book is NEVER taken from the request — it comes from whatever
 * `requireRole` resolved, which for a `gcw_` bearer token is the book the token
 * was issued for. That is the whole book-scoping story for this API: a caller
 * cannot name a book, so it cannot name the wrong one.
 */
export async function authorizeBeezRequest(
    minimumRole: Role,
): Promise<BeezRequestContext | NextResponse> {
    const roleResult = await requireRole(minimumRole);
    if (roleResult instanceof NextResponse) return roleResult;

    try {
        const context = await getBeezBookContext(roleResult.bookGuid);
        return { context, actor: { userId: roleResult.user.id } };
    } catch (error) {
        return beezErrorResponse(error);
    }
}

/**
 * Read and validate the `Idempotency-Key` header. Returns the key (or null when
 * the caller opted out), or a ready-to-send 422.
 *
 * Header only — unlike the inbound webhooks, this contract has no
 * `idempotencyKey` body field, because the body is a transaction and adding
 * transport concerns to it would make the same JSON mean two things.
 */
export function readBeezIdempotencyKey(
    request: Request,
): { ok: true; key: string | null } | { ok: false; response: NextResponse } {
    const validated = validateIdempotencyKey(request.headers.get('idempotency-key'));
    if (!validated.ok) {
        return {
            ok: false,
            response: NextResponse.json(
                { error: 'validation', detail: validated.error.replace('idempotencyKey', 'Idempotency-Key') },
                { status: 422 },
            ),
        };
    }
    return { ok: true, key: validated.key };
}

/**
 * Map a thrown error to its wire response.
 *
 * Anything unrecognised becomes a logged 500 with no detail: an integration
 * client is not the audience for a stack trace, and a database error message
 * can name columns and constraint identifiers.
 */
export function beezErrorResponse(error: unknown): NextResponse {
    if (error instanceof BeezSyncError) {
        return NextResponse.json(
            error.detail ? { error: error.code, detail: error.detail } : { error: error.code },
            { status: error.status },
        );
    }
    if (error instanceof PeriodLockedError) {
        return periodLockedResponse(error);
    }
    console.error('beez integration API error:', error);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
}

/** Parse a JSON body, or return the 422 to send. */
export async function readJsonBody(
    request: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
    try {
        return { ok: true, body: await request.json() };
    } catch {
        return {
            ok: false,
            response: NextResponse.json(
                { error: 'validation', detail: 'body: must be valid JSON' },
                { status: 422 },
            ),
        };
    }
}

/**
 * Decode an `[externalId]` path segment.
 *
 * Next.js has already percent-decoded it, so the only work left is the bounds
 * the `external_id VARCHAR(200)` column has — and those are deliberately NOT
 * spelled out here. `normalizeExternalId` is the same rule the POST body and
 * the verify batch apply, and an id one endpoint accepted while another
 * refused it would mean a record a client can create but never read back.
 */
export function parseExternalIdParam(
    raw: string,
): { ok: true; externalId: string } | { ok: false; response: NextResponse } {
    const normalized = normalizeExternalId(raw);
    if (!normalized.ok) {
        return {
            ok: false,
            response: NextResponse.json(
                { error: 'validation', detail: normalized.detail },
                { status: 422 },
            ),
        };
    }
    return { ok: true, externalId: normalized.externalId };
}
