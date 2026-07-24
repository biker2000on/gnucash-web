import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  startReconciliationSession,
  updateReconciliationSession,
} from '@/lib/reconciliation-coverage';

export async function POST(request: NextRequest) {
  const auth = await requireRole('edit');
  if (auth instanceof NextResponse) return auth;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.accountGuid !== 'string' || typeof body.statementDate !== 'string') {
    return NextResponse.json({ error: 'accountGuid and statementDate are required' }, { status: 400 });
  }
  try {
    const id = await startReconciliationSession({
      bookGuid: auth.bookGuid,
      accountGuid: body.accountGuid,
      statementDate: body.statementDate,
      userId: auth.user.id,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to start reconciliation session' },
      { status: 400 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireRole('edit');
  if (auth instanceof NextResponse) return auth;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.id !== 'string') {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }
  const status = body.status === 'completed' || body.status === 'abandoned' ? body.status : undefined;
  const updated = await updateReconciliationSession({
    id: body.id,
    bookGuid: auth.bookGuid,
    userId: auth.user.id,
    interactionDelta: typeof body.interactionDelta === 'number' ? body.interactionDelta : 0,
    status,
    endingDifference: typeof body.endingDifference === 'number' ? body.endingDifference : undefined,
  });
  return updated
    ? NextResponse.json({ updated: true })
    : NextResponse.json({ error: 'Session not found' }, { status: 404 });
}
