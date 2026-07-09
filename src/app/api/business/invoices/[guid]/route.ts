import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  getInvoiceWithStatus,
  updateInvoice,
  deleteInvoice,
} from '@/lib/business/invoice-engine';
import { mapInvoiceError } from '@/lib/business/api-errors';

/**
 * GET /api/business/invoices/[guid] — invoice with entries, totals, status.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const invoice = await getInvoiceWithStatus(guid);
    return NextResponse.json({ invoice });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/**
 * PUT /api/business/invoices/[guid] — update an UNPOSTED invoice.
 * Body: { id?, dateOpened?, notes?, billingId?, termsGuid?, currencyGuid?,
 *         active?, entries? } — when entries is present, all lines are replaced.
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
    const invoice = await updateInvoice(guid, {
      id: body.id,
      dateOpened: body.dateOpened,
      notes: body.notes,
      billingId: body.billingId,
      termsGuid: body.termsGuid,
      currencyGuid: body.currencyGuid,
      active: body.active,
      entries: body.entries,
    });
    return NextResponse.json({ invoice });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/**
 * DELETE /api/business/invoices/[guid] — delete an UNPOSTED invoice.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    await deleteInvoice(guid);
    return NextResponse.json({ success: true });
  } catch (error) {
    return mapInvoiceError(error);
  }
}
