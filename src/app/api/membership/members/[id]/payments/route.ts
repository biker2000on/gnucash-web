// src/app/api/membership/members/[id]/payments/route.ts
//
// Record a dues payment for a member. The coverage period is computed from
// the membership type's renewal mode unless the body carries an explicit
// periodStart/periodEnd override.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import {
  recordPayment,
  paymentInputSchema,
  parseInput,
  MembershipValidationError,
} from '@/lib/services/membership.service';

/**
 * POST /api/membership/members/{id}/payments
 * Body: { paidDate, membershipTypeId?, amount?, method?, reference?, notes?,
 *         periodStart?, periodEnd? }.
 * Returns { payment, paidThrough, hasLifetime }.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id } = await params;
    const memberId = Number.parseInt(id, 10);
    if (!Number.isInteger(memberId) || memberId <= 0) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    const bookGuid = await getActiveBookGuid();
    const body = await request.json().catch(() => null);
    const input = parseInput(paymentInputSchema, body);
    const result = await recordPayment(bookGuid, memberId, input);
    if (!result) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof MembershipValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error recording payment:', error);
    return NextResponse.json({ error: 'Failed to record payment' }, { status: 500 });
  }
}
