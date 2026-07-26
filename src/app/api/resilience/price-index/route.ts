import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { loadPersonalPriceIndex } from '@/lib/resilience/service';

export async function GET() {
  try {
    const auth = await requireRole('readonly');
    if (auth instanceof NextResponse) return auth;
    return NextResponse.json(await loadPersonalPriceIndex(auth.bookGuid));
  } catch (error) {
    console.error('Error building personal price index:', error);
    return NextResponse.json({ error: 'Failed to build personal price index' }, { status: 500 });
  }
}
