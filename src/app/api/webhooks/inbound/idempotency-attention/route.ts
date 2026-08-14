import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    listWebhookIdempotencyAttention,
    rearmWebhookIdempotency,
    WEBHOOK_CLAIM_STALE_MINUTES,
    WEBHOOK_MAX_ATTEMPTS,
} from '@/lib/webhook-idempotency';

/**
 * GET /api/webhooks/inbound/idempotency-attention
 *
 * Authenticated operator view for inbound events that will no longer be
 * retried automatically. A `stalled` row is intentionally read-only: timeout
 * alone is not proof that its worker died. `failed_permanent` means its write
 * failed on the final permitted attempt.
 */
export async function GET() {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const items = await listWebhookIdempotencyAttention(roleResult.bookGuid);
        return NextResponse.json({
            items: items.map(item => ({
                ...item,
                claimStartedAt: item.claimStartedAt.toISOString(),
            })),
            staleAfterMinutes: WEBHOOK_CLAIM_STALE_MINUTES,
            maxAttempts: WEBHOOK_MAX_ATTEMPTS,
        });
    } catch (error) {
        console.error('Error loading webhook idempotency attention:', error);
        return NextResponse.json(
            { error: 'Failed to load webhook idempotency attention' },
            { status: 500 }
        );
    }
}

/**
 * POST /api/webhooks/inbound/idempotency-attention
 *
 * Re-arm one terminal key after an operator fixes its cause. The storage
 * mutation is additionally guarded by `result IS NULL`, so this endpoint can
 * never turn a completed payment or transaction into a replayable claim.
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json().catch(() => null);
        const endpoint = body && typeof body === 'object'
            ? (body as { endpoint?: unknown }).endpoint
            : null;
        const idempotencyKey = body && typeof body === 'object'
            ? (body as { idempotencyKey?: unknown }).idempotencyKey
            : null;
        if (
            (endpoint !== 'transaction' && endpoint !== 'membership-payment')
            || typeof idempotencyKey !== 'string'
            || idempotencyKey.trim().length === 0
            || idempotencyKey.trim().length > 200
        ) {
            return NextResponse.json(
                { error: 'endpoint and a non-empty idempotencyKey of at most 200 characters are required' },
                { status: 400 }
            );
        }

        const rearmed = await rearmWebhookIdempotency(
            roleResult.bookGuid,
            endpoint,
            idempotencyKey.trim(),
            roleResult.user.id,
        );
        if (!rearmed) {
            return NextResponse.json(
                { error: 'No terminal, incomplete idempotency record matched this key' },
                { status: 404 }
            );
        }
        return NextResponse.json({ rearmed: true });
    } catch (error) {
        console.error('Error re-arming webhook idempotency record:', error);
        return NextResponse.json(
            { error: 'Failed to re-arm webhook idempotency record' },
            { status: 500 }
        );
    }
}
