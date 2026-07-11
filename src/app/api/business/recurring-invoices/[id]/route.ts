import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mapRecurringError } from '@/lib/business/api-errors';
import {
  getRecurringInvoice,
  updateRecurringInvoice,
  deleteRecurringInvoice,
} from '@/lib/business/recurring-invoices';

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /api/business/recurring-invoices/[id] */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    const definition = await getRecurringInvoice(roleResult.bookGuid, id);
    return NextResponse.json({ definition });
  } catch (error) {
    return mapRecurringError(error);
  }
}

/**
 * PUT /api/business/recurring-invoices/[id] — partial update.
 * Body (all optional): { name, template, periodType, mult, startDate,
 *                        nextDate, autoPost, active }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const definition = await updateRecurringInvoice(roleResult.bookGuid, id, {
      name: body.name,
      template: body.template,
      periodType: body.periodType,
      mult: body.mult !== undefined ? Number(body.mult) : undefined,
      startDate: body.startDate,
      nextDate: body.nextDate,
      autoPost: body.autoPost !== undefined ? Boolean(body.autoPost) : undefined,
      active: body.active !== undefined ? Boolean(body.active) : undefined,
    });
    return NextResponse.json({ definition });
  } catch (error) {
    return mapRecurringError(error);
  }
}

/** DELETE /api/business/recurring-invoices/[id] */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    await deleteRecurringInvoice(roleResult.bookGuid, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return mapRecurringError(error);
  }
}
