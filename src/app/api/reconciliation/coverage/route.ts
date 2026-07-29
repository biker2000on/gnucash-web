import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getReconciliationCoverage } from '@/lib/reconciliation-coverage';

export async function GET(request: NextRequest) {
  const auth = await requireRole('readonly');
  if (auth instanceof NextResponse) return auth;
  const staleDays = Math.min(365, Math.max(7, Number(request.nextUrl.searchParams.get('staleDays')) || 45));
  try {
    return NextResponse.json(await getReconciliationCoverage(auth.bookGuid, staleDays));
  } catch (error) {
    console.error('Error loading reconciliation coverage:', error);
    return NextResponse.json({ error: 'Failed to load reconciliation coverage' }, { status: 500 });
  }
}
