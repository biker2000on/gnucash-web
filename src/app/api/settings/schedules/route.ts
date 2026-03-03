import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getPreference, setPreference } from '@/lib/user-preferences';
import { signalScheduleChanged } from '@/lib/queue/queues';

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
    }

    // Determine effective state after updates
    let isEnabled: boolean;
    if (enabled !== undefined) {
      isEnabled = enabled === true || enabled === 'true';
    } else {
      const stored = await getPreference<boolean | string>(roleResult.user.id, 'refresh_enabled', false);
      isEnabled = stored === true || stored === 'true';
    }

    const effectiveHours = intervalHours !== undefined
      ? (typeof intervalHours === 'number' ? intervalHours : parseInt(String(intervalHours)))
      : await getPreference<number | string>(roleResult.user.id, 'refresh_interval_hours', 24).then(
          h => typeof h === 'number' ? h : parseInt(String(h))
        );
    await signalScheduleChanged(roleResult.user.id, isEnabled, effectiveHours);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to update refresh schedule:', error);
    return NextResponse.json(
      { error: 'Failed to update schedule settings' },
      { status: 500 }
    );
  }
}
