import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    listWebhookIdempotencyAttention,
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
