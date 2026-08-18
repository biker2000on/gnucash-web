import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getPreference, setPreference } from '@/lib/user-preferences';
import { signalScheduleChanged } from '@/lib/queue/queues';
import { isRefreshEnabled, REFRESH_ENABLED_KEY } from '@/lib/worker/refresh-schedule';

export async function GET() {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    const [enabled, intervalHours, refreshTime] = await Promise.all([
      getPreference<unknown>(roleResult.user.id, REFRESH_ENABLED_KEY, false),
      getPreference<number | string>(roleResult.user.id, 'refresh_interval_hours', 24),
      getPreference<string>(roleResult.user.id, 'refresh_time', '21:00'),
    ]);

    return NextResponse.json({
      // Same predicate the worker's restart recovery decides schedules with,
      // so what this page reports as enabled and what actually gets a timer
      // armed cannot drift apart.
      enabled: isRefreshEnabled(enabled),
      intervalHours: typeof intervalHours === 'number' ? intervalHours : parseInt(String(intervalHours)),
      refreshTime,
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
    const { enabled, intervalHours, refreshTime } = body;

    if (enabled !== undefined) {
      // Normalize on write so new rows are canonical booleans. The READ path
      // still accepts every legacy representation — existing rows are exactly
      // the population this fix is for, and they are never rewritten here.
      await setPreference(roleResult.user.id, REFRESH_ENABLED_KEY, isRefreshEnabled(enabled));
    }

    if (intervalHours !== undefined) {
      await setPreference(roleResult.user.id, 'refresh_interval_hours', intervalHours);
    }

    if (refreshTime !== undefined) {
      await setPreference(roleResult.user.id, 'refresh_time', refreshTime);
    }

    // Determine effective state after updates
    let isEnabled: boolean;
    if (enabled !== undefined) {
      isEnabled = isRefreshEnabled(enabled);
    } else {
      const stored = await getPreference<unknown>(roleResult.user.id, REFRESH_ENABLED_KEY, false);
      isEnabled = isRefreshEnabled(stored);
    }

    const effectiveHours = intervalHours !== undefined
      ? (typeof intervalHours === 'number' ? intervalHours : parseInt(String(intervalHours)))
      : await getPreference<number | string>(roleResult.user.id, 'refresh_interval_hours', 24).then(
          h => typeof h === 'number' ? h : parseInt(String(h))
        );
    const effectiveTime = refreshTime !== undefined
      ? refreshTime
      : await getPreference<string>(roleResult.user.id, 'refresh_time', '21:00');
    await signalScheduleChanged(roleResult.bookGuid, isEnabled, effectiveHours, effectiveTime);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to update refresh schedule:', error);
    return NextResponse.json(
      { error: 'Failed to update schedule settings' },
      { status: 500 }
    );
  }
}
