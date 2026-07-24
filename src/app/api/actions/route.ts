import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import {
  listFinancialActions,
  updateFinancialActions,
  FinancialActionValidationError,
} from '@/lib/financial-actions/store';
import type { FinancialActionState } from '@/lib/financial-actions/types';
import { getAuthorizedFamilyGraph } from '@/lib/family-office/service';

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
    const familyScope = request.nextUrl.searchParams.get('scope') === 'family';
    if (refresh && roleResult.role === 'readonly') {
      return NextResponse.json(
        { error: 'Refreshing actions requires edit access' },
        { status: 403 },
      );
    }
    const bookGuids = familyScope
      ? (await getAuthorizedFamilyGraph(roleResult.user.id, roleResult.bookGuid)).entities.map(entity => entity.bookGuid)
      : [roleResult.bookGuid];
    const results = await Promise.all(bookGuids.map(async bookGuid => {
      const bookAccountGuids = await getAccountGuidsForBook(bookGuid);
      return listFinancialActions({
        userId: roleResult.user.id,
        bookGuid,
        bookAccountGuids,
        includeCompleted,
        refresh,
      });
    }));
    if (!familyScope) return NextResponse.json(results[0]);
    const verifiedDates = results.map(result => result.verifiedThrough).filter((date): date is string => !!date);
    return NextResponse.json({
      actions: results.flatMap(result => result.actions),
      summary: results.reduce((summary, result) => ({
        new: summary.new + result.summary.new,
        resolved: summary.resolved + result.summary.resolved,
        automated: summary.automated + result.summary.automated,
        overdue: summary.overdue + result.summary.overdue,
      }), { new: 0, resolved: 0, automated: 0, overdue: 0 }),
      verifiedThrough: verifiedDates.length === results.length ? verifiedDates.sort()[0] : null,
      generatedAt: new Date().toISOString(),
      scope: 'family',
    });
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
    const familyScope = request.nextUrl.searchParams.get('scope') === 'family';
    const bookGuids = familyScope
      ? (await getAuthorizedFamilyGraph(roleResult.user.id, roleResult.bookGuid)).entities
          .filter(entity => entity.role === 'edit' || entity.role === 'admin')
          .map(entity => entity.bookGuid)
      : [roleResult.bookGuid];
    let updated = 0;
    for (const bookGuid of bookGuids) {
      updated += await updateFinancialActions({
        userId: roleResult.user.id,
        bookGuid,
        ids: body.ids,
        state: body.state as FinancialActionState,
        snoozedUntil: body.snoozedUntil as string | null | undefined,
      });
    }
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
