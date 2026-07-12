import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  deleteWebhook,
  updateWebhook,
  validateWebhookUrl,
  type WebhookRecord,
} from '@/lib/webhooks';

function serializeWebhook(hook: WebhookRecord) {
  return {
    id: hook.id,
    bookGuid: hook.bookGuid,
    url: hook.url,
    secret: hook.secret,
    events: hook.events,
    enabled: hook.enabled,
    createdAt: hook.createdAt.toISOString(),
    lastStatus: hook.lastStatus,
    lastDeliveredAt: hook.lastDeliveredAt?.toISOString() ?? null,
  };
}

/**
 * PUT /api/settings/webhooks/[id] — update a webhook.
 * Body: { url?, secret?, events?: 'all'|string[], enabled?, allowInternal? }
 */
export async function PUT(
  request: NextRequest,
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

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    if (body.url !== undefined) {
      if (typeof body.url !== 'string') {
        return NextResponse.json({ error: 'url must be a string' }, { status: 400 });
      }
      const validation = validateWebhookUrl(body.url, { allowInternal: body.allowInternal === true });
      if (!validation.ok) {
        return NextResponse.json({ error: validation.error }, { status: 400 });
      }
    }

    let events: 'all' | string[] | undefined;
    if (body.events !== undefined) {
      events = body.events === 'all'
        ? 'all'
        : Array.isArray(body.events)
          ? body.events.filter((e: unknown): e is string => typeof e === 'string' && e.length > 0 && e.length <= 50)
          : 'all';
    }

    const webhook = await updateWebhook(roleResult.user.id, id, {
      url: body.url,
      secret: typeof body.secret === 'string' ? body.secret : undefined,
      events,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    });
    if (!webhook) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }
    return NextResponse.json({ webhook: serializeWebhook(webhook) });
  } catch (error) {
    console.error('Error updating webhook:', error);
    return NextResponse.json({ error: 'Failed to update webhook' }, { status: 500 });
  }
}

/** DELETE /api/settings/webhooks/[id] — delete a webhook. */
export async function DELETE(
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

    const deleted = await deleteWebhook(roleResult.user.id, id);
    if (!deleted) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting webhook:', error);
    return NextResponse.json({ error: 'Failed to delete webhook' }, { status: 500 });
  }
}
