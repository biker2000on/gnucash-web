import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listInvoices, createInvoice } from '@/lib/business/invoice-engine';
import { mapInvoiceError } from '@/lib/business/api-errors';
import type { InvoiceKind, InvoiceStatus } from '@/lib/business/invoice-totals';

/**
 * GET /api/business/invoices
 * Query params: type=invoice|bill, status=draft|open|paid|overdue,
 *               ownerGuid, limit (default 100), offset (default 0)
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type');
    const status = searchParams.get('status');
    if (type && !['invoice', 'bill'].includes(type)) {
      return NextResponse.json({ error: `Invalid type: ${type}` }, { status: 400 });
    }
    if (status && !['draft', 'open', 'paid', 'overdue'].includes(status)) {
      return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 });
    }

    const invoices = await listInvoices({
      type: (type as InvoiceKind) ?? undefined,
      status: (status as InvoiceStatus) ?? undefined,
      ownerGuid: searchParams.get('ownerGuid') ?? undefined,
      limit: searchParams.get('limit') ? parseInt(searchParams.get('limit')!, 10) : undefined,
      offset: searchParams.get('offset') ? parseInt(searchParams.get('offset')!, 10) : undefined,
    });

    return NextResponse.json({ invoices });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/**
 * POST /api/business/invoices — create a draft invoice or bill.
 * Body: { ownerType: 'customer'|'vendor'|'job', ownerGuid, id?, dateOpened?,
 *         notes?, billingId?, termsGuid?, currencyGuid?, entries: [...] }
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    if (!body.ownerType || !body.ownerGuid) {
      return NextResponse.json({ error: 'ownerType and ownerGuid are required' }, { status: 400 });
    }
    if (!Array.isArray(body.entries)) {
      return NextResponse.json({ error: 'entries array is required' }, { status: 400 });
    }

    const invoice = await createInvoice({
      ownerType: body.ownerType,
      ownerGuid: body.ownerGuid,
      id: body.id,
      dateOpened: body.dateOpened,
      notes: body.notes,
      billingId: body.billingId,
      termsGuid: body.termsGuid,
      currencyGuid: body.currencyGuid,
      entries: body.entries,
      bookGuid: roleResult.bookGuid,
    });

    return NextResponse.json({ invoice }, { status: 201 });
  } catch (error) {
    return mapInvoiceError(error);
  }
}
