import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  syncSimpleFinStatusNotification,
} from '@/lib/notifications';

export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { user, bookGuid } = roleResult;
    const limitParam = request.nextUrl.searchParams.get('limit');
    const limit = Math.min(Math.max(Number(limitParam) || 20, 1), 50);

    await syncSimpleFinStatusNotification(user.id, bookGuid);
    const result = await listNotifications(user.id, bookGuid, limit);

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    return NextResponse.json({ error: 'Failed to fetch notifications' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { user, bookGuid } = roleResult;
    const body = await request.json().catch(() => ({}));

    if (body?.all) {
      await markAllNotificationsRead(user.id, bookGuid);
    } else if (Number.isInteger(body?.id)) {
      await markNotificationRead(user.id, body.id);
    } else {
      return NextResponse.json({ error: 'Notification id or all=true is required' }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating notifications:', error);
    return NextResponse.json({ error: 'Failed to update notifications' }, { status: 500 });
  }
}
