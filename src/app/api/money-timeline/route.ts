import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getMoneyTimeline } from '@/lib/money-timeline/service';

function dateParam(value: string | null): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireRole('readonly');
    if (auth instanceof NextResponse) return auth;
    const minimumCashRaw = Number(request.nextUrl.searchParams.get('minimumCash'));
    const timeline = await getMoneyTimeline(auth.user.id, auth.bookGuid, {
      from: dateParam(request.nextUrl.searchParams.get('from')),
      to: dateParam(request.nextUrl.searchParams.get('to')),
      minimumCash: Number.isFinite(minimumCashRaw) ? Math.max(0, minimumCashRaw) : 0,
    });
    return NextResponse.json(timeline);
  } catch (error) {
    console.error('Error loading Money Timeline:', error);
    return NextResponse.json({ error: 'Failed to load Money Timeline' }, { status: 500 });
  }
}
