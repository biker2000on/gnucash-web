import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mapRecurringError } from '@/lib/business/api-errors';
import {
  listRecurringInvoices,
  createRecurringInvoice,
} from '@/lib/business/recurring-invoices';

/** GET /api/business/recurring-invoices — list the book's definitions. */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const definitions = await listRecurringInvoices(roleResult.bookGuid);
    return NextResponse.json({ definitions });
  } catch (error) {
    return mapRecurringError(error);
  }
}

/**
 * POST /api/business/recurring-invoices — create a definition.
 * Body: { name, ownerType: 'customer'|'vendor', ownerGuid,
 *         template: { entries: [...], notes?, billingId?, termsGuid?, currencyGuid? },
 *         periodType: 'daily'|'weekly'|'month'|'year', mult, startDate,
 *         autoPost?, active? }
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const definition = await createRecurringInvoice(roleResult.bookGuid, {
      name: body.name,
      ownerType: body.ownerType,
      ownerGuid: body.ownerGuid,
      template: body.template,
      periodType: body.periodType,
      mult: Number(body.mult ?? 1),
      startDate: body.startDate,
      autoPost: Boolean(body.autoPost),
      active: body.active !== undefined ? Boolean(body.active) : true,
    });
    return NextResponse.json({ definition }, { status: 201 });
  } catch (error) {
    return mapRecurringError(error);
  }
}
