// POST /api/webhooks/inbound/membership-payment
//
// Convenience endpoint for automation tools (n8n, Zeffy exports, scripts):
// record a membership dues payment with a minimal JSON body. Authenticated
// like every other endpoint — a Bearer `gcw_...` personal access token (or
// a browser session) with the edit role; the payment lands in the token's
// book. Coverage period is derived from the member's membership type via the
// same service the membership UI uses.
//
// Body: { memberId, amount?, paidDate, method?, reference? }

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { withPeriodLockCheck } from '@/lib/services/period-lock.service';
import {
    recordPayment,
    MembershipValidationError,
} from '@/lib/services/membership.service';
import { inboundMembershipPaymentSchema, parseInbound } from '@/lib/inbound-webhooks';

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

        // Period lock: dues payments are book records too — respect the lock.
        const lockError = await withPeriodLockCheck(bookGuid, [input.paidDate]);
        if (lockError) return lockError;

        const result = await recordPayment(bookGuid, input.memberId, {
            membershipTypeId: null,
            amount: input.amount ?? null,
            paidDate: input.paidDate,
            method: input.method,
            reference: input.reference ?? null,
            notes: 'Recorded via inbound webhook',
            periodStart: null,
            periodEnd: null,
        });
        if (!result) {
            return NextResponse.json({ error: 'Member not found' }, { status: 404 });
        }

        return NextResponse.json({ success: true, ...result }, { status: 201 });
    } catch (error) {
        if (error instanceof MembershipValidationError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        console.error('Error in inbound membership-payment webhook:', error);
        return NextResponse.json({ error: 'Failed to record payment' }, { status: 500 });
    }
}
