import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getCalculationTrace } from '@/lib/provenance';

interface RouteParams {
  params: Promise<{ traceId: string }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { traceId } = await params;
    if (!/^trace_[0-9a-f]{32}$/.test(traceId)) {
      return NextResponse.json({ error: 'Invalid trace ID' }, { status: 400 });
    }
    const trace = await getCalculationTrace(
      roleResult.user.id,
      roleResult.bookGuid,
      traceId,
    );
    if (!trace) {
      return NextResponse.json({ error: 'Calculation trace not found' }, { status: 404 });
    }
    return NextResponse.json(trace);
  } catch (error) {
    console.error('Error loading calculation trace:', error);
    return NextResponse.json({ error: 'Failed to load calculation trace' }, { status: 500 });
  }
}
