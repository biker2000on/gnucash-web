import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import {
  listFinancialActions,
  updateFinancialActions,
  FinancialActionValidationError,
} from '@/lib/financial-actions/store';
import type { FinancialActionState } from '@/lib/financial-actions/types';

const WRITABLE_STATES = new Set<FinancialActionState>([
  'open',
  'snoozed',
  'accepted',
  'resolved',
  'dismissed',
]);
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const includeCompleted = request.nextUrl.searchParams.get('includeCompleted') === 'true';
    const refresh = request.nextUrl.searchParams.get('refresh') === 'true';
    if (refresh && roleResult.role === 'readonly') {
      return NextResponse.json(
        { error: 'Refreshing actions requires edit access' },
        { status: 403 },
      );
    }
    const bookAccountGuids = await getAccountGuidsForBook(roleResult.bookGuid);
    const result = await listFinancialActions({
      userId: roleResult.user.id,
      bookGuid: roleResult.bookGuid,
      bookAccountGuids,
      includeCompleted,
      refresh,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error loading Financial Action Center:', error);
    return NextResponse.json(
      { error: 'Failed to load the Financial Action Center' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const body = await request.json().catch(() => null) as {
      ids?: unknown;
      state?: unknown;
      snoozedUntil?: unknown;
    } | null;
    if (!body || !Array.isArray(body.ids) || !body.ids.every(id => typeof id === 'string')) {
      return NextResponse.json({ error: 'ids must be an array of action IDs' }, { status: 400 });
    }
    if (typeof body.state !== 'string' || !WRITABLE_STATES.has(body.state as FinancialActionState)) {
      return NextResponse.json({ error: 'Invalid action state' }, { status: 400 });
    }
    if (body.snoozedUntil !== undefined && body.snoozedUntil !== null && typeof body.snoozedUntil !== 'string') {
      return NextResponse.json({ error: 'snoozedUntil must be an ISO date' }, { status: 400 });
    }
    const updated = await updateFinancialActions({
      userId: roleResult.user.id,
      bookGuid: roleResult.bookGuid,
      ids: body.ids,
      state: body.state as FinancialActionState,
      snoozedUntil: body.snoozedUntil as string | null | undefined,
    });
    return NextResponse.json({ ok: true, updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update actions';
    const clientError = error instanceof FinancialActionValidationError;
    console.error('Error updating Financial Action Center:', error);
    return NextResponse.json(
      { error: clientError ? message : 'Failed to update actions' },
      { status: clientError ? 400 : 500 },
    );
  }
}
