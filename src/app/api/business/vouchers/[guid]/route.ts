import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getVoucher, updateVoucher, deleteVoucher } from '@/lib/business/vouchers';
import { mapInvoiceError } from '@/lib/business/api-errors';

/** GET /api/business/vouchers/[guid] — voucher detail with entries. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const voucher = await getVoucher(guid);
    return NextResponse.json({ voucher });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/**
 * PUT /api/business/vouchers/[guid] — update a DRAFT voucher.
 * Body: { id?, dateOpened?, notes?, billingId?, active?, entries? }
 * Posted vouchers reject with 409 (unpost first).
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const body = await request.json();
    const voucher = await updateVoucher(guid, {
      id: body.id,
      dateOpened: body.dateOpened,
      notes: body.notes,
      billingId: body.billingId,
      active: body.active,
      entries: body.entries,
    });
    return NextResponse.json({ voucher });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/** DELETE /api/business/vouchers/[guid] — delete a DRAFT voucher (409 when posted). */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    await deleteVoucher(guid);
    return NextResponse.json({ success: true });
  } catch (error) {
    return mapInvoiceError(error);
  }
}
