import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listVouchers, createVoucher } from '@/lib/business/vouchers';
import { mapInvoiceError } from '@/lib/business/api-errors';
import type { InvoiceStatus } from '@/lib/business/invoice-totals';

/**
 * GET /api/business/vouchers
 * Query params: status=draft|open|paid|overdue, employeeGuid,
 *               limit (default 100), offset (default 0)
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    if (status && !['draft', 'open', 'paid', 'overdue'].includes(status)) {
      return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 });
    }

    const vouchers = await listVouchers({
      status: (status as InvoiceStatus) ?? undefined,
      employeeGuid: searchParams.get('employeeGuid') ?? undefined,
      limit: searchParams.get('limit') ? parseInt(searchParams.get('limit')!, 10) : undefined,
      offset: searchParams.get('offset') ? parseInt(searchParams.get('offset')!, 10) : undefined,
    });

    return NextResponse.json({ vouchers });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/**
 * POST /api/business/vouchers — create a draft expense voucher.
 * Body: { employeeGuid, id?, dateOpened?, notes?, billingId?,
 *         entries: [{ description?, accountGuid, quantity, price, ... }] }
 * Numbering uses the book's 'counters/gncExpVoucher' slot when id is omitted.
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    if (!body.employeeGuid) {
      return NextResponse.json({ error: 'employeeGuid is required' }, { status: 400 });
    }
    if (!Array.isArray(body.entries)) {
      return NextResponse.json({ error: 'entries array is required' }, { status: 400 });
    }

    const voucher = await createVoucher({
      employeeGuid: body.employeeGuid,
      id: body.id,
      dateOpened: body.dateOpened,
      notes: body.notes,
      billingId: body.billingId,
      entries: body.entries,
      bookGuid: roleResult.bookGuid,
    });

    return NextResponse.json({ voucher }, { status: 201 });
  } catch (error) {
    return mapInvoiceError(error);
  }
}
