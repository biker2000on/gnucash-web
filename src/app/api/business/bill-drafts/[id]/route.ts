import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import {
  resolveEmailBill,
  dismissEmailBill,
  EmailBillNotFoundError,
  EmailBillStateError,
} from '@/lib/business/bill-capture';
import { mapInvoiceError } from '@/lib/business/api-errors';

/**
 * POST /api/business/bill-drafts/[id] — resolve a needs-review capture.
 * Body: { vendorGuid, amount?, date? } → creates the draft vendor bill.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: idParam } = await params;
    const id = parseInt(idParam, 10);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    if (!body?.vendorGuid || typeof body.vendorGuid !== 'string') {
      return NextResponse.json({ error: 'vendorGuid is required' }, { status: 400 });
    }
    const amount = body.amount === undefined || body.amount === null ? null : Number(body.amount);
    if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 });
    }
    const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : null;

    const bookGuid = await getActiveBookGuid();
    const bill = await resolveEmailBill({ id, bookGuid, vendorGuid: body.vendorGuid, amount, date });
    return NextResponse.json({ bill });
  } catch (error) {
    if (error instanceof EmailBillNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof EmailBillStateError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return mapInvoiceError(error);
  }
}

/**
 * DELETE /api/business/bill-drafts/[id] — dismiss a capture from the review
 * queue (the underlying receipt is untouched).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: idParam } = await params;
    const id = parseInt(idParam, 10);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const bookGuid = await getActiveBookGuid();
    const dismissed = await dismissEmailBill(id, bookGuid);
    if (!dismissed) {
      return NextResponse.json(
        { error: 'Bill draft not found or not dismissible' },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error dismissing email bill draft:', error);
    return NextResponse.json({ error: 'Failed to dismiss bill draft' }, { status: 500 });
  }
}
