import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { syncFuelTracker } from '@/lib/resilience/service';

export async function POST() {
  try {
    const auth = await requireRole('edit');
    if (auth instanceof NextResponse) return auth;
    return NextResponse.json(await syncFuelTracker({
      bookGuid: auth.bookGuid,
      userId: auth.user.id,
      bookAccountGuids: await getBookAccountGuids(),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Fuel Tracker sync failed';
    console.error('Fuel Tracker sync failed:', error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
