import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mapRecurringError } from '@/lib/business/api-errors';
import { runDueRecurringInvoices } from '@/lib/business/recurring-invoices';

/**
 * POST /api/business/recurring-invoices/run — generate all due occurrences.
 * Body (optional): { id?: number, asOf?: 'YYYY-MM-DD' }
 *   - id limits the run to one definition ("Run now").
 *   - asOf defaults to today; occurrences with next_date <= asOf are generated.
 * Response: { generated, results: [{ defId, name, occurrences, error? }] }
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => ({}));
    const defId = body?.id !== undefined ? Number(body.id) : undefined;
    if (defId !== undefined && (!Number.isInteger(defId) || defId <= 0)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const result = await runDueRecurringInvoices(roleResult.bookGuid, {
      userId: roleResult.user.id,
      asOf: typeof body?.asOf === 'string' ? body.asOf : undefined,
      defId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return mapRecurringError(error);
  }
}
