// POST /api/webhooks/inbound/membership-payment
//
// Convenience endpoint for automation tools (n8n, Zeffy exports, scripts):
// record a membership dues payment with a minimal JSON body. Authenticated
// like every other endpoint — a Bearer `gcw_...` personal access token (or
// a browser session) with the edit role; the payment lands in the token's
// book. Coverage period is derived from the member's membership type via the
// same service the membership UI uses.
//
// Body: { memberId, amount?, paidDate, method?, reference?, idempotencyKey? }
//
// Idempotency: pass an `Idempotency-Key` header or an `idempotencyKey` body
// field. The key is claimed against a UNIQUE index before the write, so an
// n8n/Zeffy retry after a timeout is rejected by the database (and gets the
// original response back) instead of recording a second dues payment.

import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { withPeriodLockCheck } from '@/lib/services/period-lock.service';
import {
    recordPayment,
    MembershipValidationError,
} from '@/lib/services/membership.service';
import { inboundMembershipPaymentSchema, parseInbound } from '@/lib/inbound-webhooks';
import {
    claimWebhookIdempotency,
    completeWebhookIdempotency,
    lockWebhookIdempotencyAttempt,
    readIdempotencyKey,
    releaseWebhookIdempotency,
    validateIdempotencyKey,
    WebhookClaimSupersededError,
} from '@/lib/webhook-idempotency';

export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const body = await request.json().catch(() => null);
        const parsed = parseInbound(inboundMembershipPaymentSchema, body);
        if (!parsed.ok) {
            return NextResponse.json({ error: parsed.error }, { status: 400 });
        }
        const input = parsed.data;

        const keyCheck = validateIdempotencyKey(
            readIdempotencyKey(request.headers.get('idempotency-key'), body)
        );
        if (!keyCheck.ok) {
            return NextResponse.json({ error: keyCheck.error }, { status: 400 });
        }
        const idempotencyKey = keyCheck.key;

        // Period lock: dues payments are book records too — respect the lock.
        const lockError = await withPeriodLockCheck(bookGuid, [input.paidDate]);
        if (lockError) return lockError;

        // Claim the idempotency key BEFORE the write. The UNIQUE index picks
        // the winner, so a concurrent replay can never also reach recordPayment.
        let claimAttempt: number | null = null;
        if (idempotencyKey) {
            const claim = await claimWebhookIdempotency(
                bookGuid,
                'membership-payment',
                idempotencyKey
            );
            if (claim.status === 'replay') {
                if (claim.result) {
                    return NextResponse.json(
                        { ...(claim.result as Record<string, unknown>), replayed: true },
                        { status: 200 }
                    );
                }
                return NextResponse.json(
                    { error: 'A request with this idempotencyKey is already in progress' },
                    { status: 409 }
                );
            }
            if (claim.status === 'terminal') {
                return NextResponse.json(
                    {
                        error: 'This idempotency key exhausted its retry budget and needs operator attention',
                        idempotencyState: claim.state,
                        attempts: claim.attempts,
                        detail: claim.detail,
                    },
                    { status: 409 }
                );
            }
            claimAttempt = claim.attempt;
        }

        let result;
        try {
            const paymentInput = {
                membershipTypeId: null,
                amount: input.amount ?? null,
                paidDate: input.paidDate,
                method: input.method,
                reference: input.reference ?? null,
                notes: 'Recorded via inbound webhook',
                periodStart: null,
                periodEnd: null,
            };
            if (idempotencyKey) {
                result = await prisma.$transaction(async (database) => {
                    // Lock the attempt before recording payment. Completion is
                    // in this same transaction, so no successful payment can
                    // be reclaimed solely because its response was not saved.
                    await lockWebhookIdempotencyAttempt(
                        bookGuid, 'membership-payment', idempotencyKey, claimAttempt!, database
                    );
                    const recorded = await recordPayment(
                        bookGuid, input.memberId, paymentInput, database
                    );
                    if (!recorded) {
                        await releaseWebhookIdempotency(
                            bookGuid, 'membership-payment', idempotencyKey, claimAttempt!, database
                        );
                        return null;
                    }
                    const completed = await completeWebhookIdempotency(
                        bookGuid, 'membership-payment', idempotencyKey, claimAttempt!,
                        { success: true, ...recorded }, database
                    );
                    if (!completed) throw new WebhookClaimSupersededError();
                    return recorded;
                });
            } else {
                result = await recordPayment(bookGuid, input.memberId, paymentInput);
            }
        } catch (writeError) {
            if (writeError instanceof WebhookClaimSupersededError) {
                return NextResponse.json(
                    { error: 'A newer request with this idempotencyKey is already in progress' },
                    { status: 409 }
                );
            }
            // Nothing was recorded — free the key so a genuine retry works.
            if (idempotencyKey) {
                await releaseWebhookIdempotency(
                    bookGuid, 'membership-payment', idempotencyKey, claimAttempt!
                );
            }
            throw writeError;
        }
        if (!result) {
            return NextResponse.json({ error: 'Member not found' }, { status: 404 });
        }

        const payload = { success: true, ...result };

        return NextResponse.json(payload, { status: 201 });
    } catch (error) {
        if (error instanceof MembershipValidationError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        console.error('Error in inbound membership-payment webhook:', error);
        return NextResponse.json({ error: 'Failed to record payment' }, { status: 500 });
    }
}
