import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getPreference, setPreference } from '@/lib/user-preferences';
import { scheduleRefreshPrices } from '@/lib/queue/queues';

export async function GET() {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    const enabled = await getPreference<boolean | string>(roleResult.user.id, 'refresh_enabled', false);
    const intervalHours = await getPreference<number | string>(roleResult.user.id, 'refresh_interval_hours', 24);

    return NextResponse.json({
      enabled: enabled === true || enabled === 'true',
      intervalHours: typeof intervalHours === 'number' ? intervalHours : parseInt(String(intervalHours)),
    });
  } catch (error) {
    console.error('Failed to get refresh schedule:', error);
    return NextResponse.json(
      { error: 'Failed to load schedule settings' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const { enabled, intervalHours } = body;

    if (enabled !== undefined) {
      await setPreference(roleResult.user.id, 'refresh_enabled', enabled);
    }

    if (intervalHours !== undefined) {
      await setPreference(roleResult.user.id, 'refresh_interval_hours', intervalHours);
      // Only reschedule if enabled
      const isEnabled = enabled !== undefined ? enabled : await getPreference<boolean | string>(roleResult.user.id, 'refresh_enabled', false);
      if (isEnabled === true || isEnabled === 'true') {
        await scheduleRefreshPrices(intervalHours);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to update refresh schedule:', error);
    return NextResponse.json(
      { error: 'Failed to update schedule settings' },
      { status: 500 }
    );
  }
}
