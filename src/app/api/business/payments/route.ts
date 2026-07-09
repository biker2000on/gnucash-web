import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { applyPayment, listPayments } from '@/lib/business/invoice-engine';
import { mapInvoiceError } from '@/lib/business/api-errors';

/**
 * GET /api/business/payments?ownerType=customer|vendor&ownerGuid=...
 * Lists payment transactions applied to the owner's posted invoices/bills.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const ownerType = searchParams.get('ownerType');
    const ownerGuid = searchParams.get('ownerGuid');
    if (!ownerType || !ownerGuid || !['customer', 'vendor'].includes(ownerType)) {
      return NextResponse.json(
        { error: "ownerType ('customer'|'vendor') and ownerGuid are required" },
        { status: 400 }
      );
    }

    const payments = await listPayments(ownerType as 'customer' | 'vendor', ownerGuid);
    return NextResponse.json({ payments });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/**
 * POST /api/business/payments — apply a payment to open invoices/bills.
 * Body: { ownerType: 'customer'|'vendor', ownerGuid, transferAccountGuid,
 *         amount, date: 'YYYY-MM-DD', num?, memo?,
 *         allocations?: [{ invoiceGuid, amount }] }
 * Without allocations, applies oldest-first; overpayments are rejected (400).
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    if (!body.ownerType || !['customer', 'vendor'].includes(body.ownerType)) {
      return NextResponse.json(
        { error: "ownerType must be 'customer' or 'vendor'" },
        { status: 400 }
      );
    }
    for (const field of ['ownerGuid', 'transferAccountGuid', 'amount', 'date'] as const) {
      if (body[field] === undefined || body[field] === null || body[field] === '') {
        return NextResponse.json({ error: `${field} is required` }, { status: 400 });
      }
    }

    const result = await applyPayment({
      ownerType: body.ownerType,
      ownerGuid: body.ownerGuid,
      transferAccountGuid: body.transferAccountGuid,
      amount: Number(body.amount),
      date: body.date,
      num: body.num,
      memo: body.memo,
      allocations: body.allocations,
    });
    return NextResponse.json({ result }, { status: 201 });
  } catch (error) {
    return mapInvoiceError(error);
  }
}
