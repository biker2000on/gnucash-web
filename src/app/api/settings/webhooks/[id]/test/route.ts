import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { deliverToWebhook, getWebhook } from '@/lib/webhooks';

/**
 * POST /api/settings/webhooks/[id]/test — send a signed test event to the
 * webhook's URL and report the delivery status.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    if (roleResult.viaToken) {
      return NextResponse.json({ error: 'API tokens cannot manage webhooks' }, { status: 403 });
    }

    const { id: idParam } = await params;
    const id = parseInt(idParam, 10);
    if (!Number.isInteger(id)) {
      return NextResponse.json({ error: 'Invalid webhook id' }, { status: 400 });
    }

    const webhook = await getWebhook(roleResult.user.id, id);
    if (!webhook) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }

    const status = await deliverToWebhook(webhook, {
      id: 0,
      userId: roleResult.user.id,
      bookGuid: webhook.bookGuid ?? roleResult.bookGuid,
      type: 'webhook_test',
      severity: 'info',
      title: 'Test event from GnuCash Web',
      message: 'If you can read this, your webhook endpoint and signature verification are working.',
      href: '/settings',
      createdAt: new Date(),
    });

    const ok = /^\d+$/.test(status) && Number(status) < 400;
    return NextResponse.json({ ok, status });
  } catch (error) {
    console.error('Error testing webhook:', error);
    return NextResponse.json({ error: 'Failed to test webhook' }, { status: 500 });
  }
}
