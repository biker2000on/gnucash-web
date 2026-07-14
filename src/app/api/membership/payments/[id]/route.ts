// src/app/api/membership/payments/[id]/route.ts
//
// Delete a recorded dues payment (e.g. entered in error).

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { deletePayment } from '@/lib/services/membership.service';

/** DELETE /api/membership/payments/{id} */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id } = await params;
    const paymentId = Number.parseInt(id, 10);
    if (!Number.isInteger(paymentId) || paymentId <= 0) {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
    }

    const bookGuid = await getActiveBookGuid();
    const result = await deletePayment(bookGuid, paymentId);
    if (!result) {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error deleting payment:', error);
    return NextResponse.json({ error: 'Failed to delete payment' }, { status: 500 });
  }
}
