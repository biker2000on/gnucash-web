import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  createWebhook,
  listWebhooks,
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

function parseEventsInput(raw: unknown): 'all' | string[] {
  if (raw === 'all' || raw === undefined || raw === null) return 'all';
  if (Array.isArray(raw)) {
    return raw.filter((e): e is string => typeof e === 'string' && e.length > 0 && e.length <= 50);
  }
  return 'all';
}

/** GET /api/settings/webhooks — list webhooks for the current user + active book. */
export async function GET() {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    if (roleResult.viaToken) {
      return NextResponse.json({ error: 'API tokens cannot manage webhooks' }, { status: 403 });
    }

    const webhooks = await listWebhooks(roleResult.user.id, roleResult.bookGuid);
    return NextResponse.json({ webhooks: webhooks.map(serializeWebhook) });
  } catch (error) {
    console.error('Error listing webhooks:', error);
    return NextResponse.json({ error: 'Failed to list webhooks' }, { status: 500 });
  }
}

/**
 * POST /api/settings/webhooks — create a webhook for the active book.
 * Body: { url, secret?, events?: 'all'|string[], enabled?, allowInternal?, allBooks? }
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    if (roleResult.viaToken) {
      return NextResponse.json({ error: 'API tokens cannot manage webhooks' }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body.url !== 'string') {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }

    const validation = validateWebhookUrl(body.url, { allowInternal: body.allowInternal === true });
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const webhook = await createWebhook(roleResult.user.id, {
      bookGuid: body.allBooks === true ? null : roleResult.bookGuid,
      url: body.url,
      secret: typeof body.secret === 'string' ? body.secret : undefined,
      events: parseEventsInput(body.events),
      enabled: body.enabled !== false,
    });

    return NextResponse.json({ webhook: serializeWebhook(webhook) }, { status: 201 });
  } catch (error) {
    console.error('Error creating webhook:', error);
    return NextResponse.json({ error: 'Failed to create webhook' }, { status: 500 });
  }
}
