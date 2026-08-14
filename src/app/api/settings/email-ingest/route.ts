import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { hasTargetBookRole } from '@/lib/target-book-auth';
import { enqueueJob } from '@/lib/queue/queues';
import {
  addIngestSender,
  getEmailIngestConfig,
  INGEST_KINDS,
  listIngestAttention,
  listIngestLog,
  listIngestSenders,
  type IngestDefaultKind,
  type IngestAttentionEntry,
  type IngestAttentionList,
  type IngestLogEntry,
  type IngestSender,
} from '@/lib/email-ingest';

/** Cap on the attention list. The response always reports the TRUE totals. */
const ATTENTION_LIMIT = 50;

function serializeSender(sender: IngestSender) {
  return {
    id: sender.id,
    email: sender.email,
    userId: sender.userId,
    bookGuid: sender.bookGuid,
    defaultKind: sender.defaultKind,
    createdAt: sender.createdAt.toISOString(),
  };
}

function serializeLogEntry(entry: IngestLogEntry) {
  return {
    id: entry.id,
    fromEmail: entry.fromEmail,
    subject: entry.subject,
    outcome: entry.outcome,
    detail: entry.detail,
    ingestedCount: entry.ingestedCount,
    attempts: entry.attempts,
    processedAt: entry.processedAt.toISOString(),
  };
}

function serializeAttentionEntry(entry: IngestAttentionEntry) {
  return { ...serializeLogEntry(entry), category: entry.category };
}

/**
 * GET /api/settings/email-ingest — ingest status: whether the mailbox is
 * configured (env-based), the sender allowlist, and the recent ingest log.
 */
export async function GET() {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const config = getEmailIngestConfig();
    // Items needing attention are queried separately from the capped
    // recent-activity list, so later successes can never hide an outstanding
    // failure by pushing it off the end — and they carry TRUE totals so a
    // truncated list still reports the real size of the backlog.
    const emptyAttention: IngestAttentionList =
      { items: [], failedTotal: 0, stalledTotal: 0, truncated: false };
    const [senders, log, attention] = config
      ? await Promise.all([
          listIngestSenders(),
          listIngestLog(10),
          listIngestAttention(roleResult.user.id, ATTENTION_LIMIT),
        ])
      : [[] as IngestSender[], [] as IngestLogEntry[], emptyAttention];

    return NextResponse.json({
      configured: config !== null,
      folder: config?.folder ?? null,
      mailboxUser: config?.user ?? null,
      defaultBookGuid: config?.defaultBookGuid ?? null,
      senders: senders.map(serializeSender),
      log: log.map(serializeLogEntry),
      attention: {
        items: attention.items.map(serializeAttentionEntry),
        failedTotal: attention.failedTotal,
        stalledTotal: attention.stalledTotal,
        shown: attention.items.length,
        truncated: attention.truncated,
        limit: ATTENTION_LIMIT,
      },
    });
  } catch (error) {
    console.error('Error loading email-ingest settings:', error);
    return NextResponse.json({ error: 'Failed to load email ingest settings' }, { status: 500 });
  }
}

/**
 * POST /api/settings/email-ingest
 * - `{ action: 'poll' }` — poll the mailbox now (enqueued; inline if Redis
 *   is unavailable).
 * - `{ email, defaultKind?, bookGuid? }` — add a sender to the allowlist,
 *   owned by the current user and (by default) the active book.
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    if (body.action === 'poll') {
      const config = getEmailIngestConfig();
      if (!config) {
        return NextResponse.json(
          { error: 'Email ingest is not configured (set INGEST_IMAP_* env vars)' },
          { status: 400 },
        );
      }
      const jobId = await enqueueJob('poll-email-ingest');
      if (jobId) {
        return NextResponse.json({ enqueued: true, jobId });
      }
      // Redis unavailable — poll inline.
      const { pollEmailIngest } = await import('@/lib/email-ingest');
      const result = await pollEmailIngest();
      return NextResponse.json({ enqueued: false, result });
    }

    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'A valid sender email is required' }, { status: 400 });
    }

    const defaultKind: IngestDefaultKind = INGEST_KINDS.includes(body.defaultKind)
      ? body.defaultKind
      : 'auto';

    const bookGuid =
      typeof body.bookGuid === 'string' && body.bookGuid.trim()
        ? body.bookGuid.trim()
        : roleResult.bookGuid;

    // requireRole authorized the ACTIVE book; a caller-supplied guid is a
    // different book and needs its own check. Without this, anyone with edit
    // on their own book could route inbound mail into someone else's.
    if (bookGuid !== roleResult.bookGuid) {
      const allowed = await hasTargetBookRole(roleResult, bookGuid, 'edit');
      if (!allowed) {
        return NextResponse.json({ error: 'No access to the requested book' }, { status: 403 });
      }
    }

    const sender = await addIngestSender({
      email,
      userId: roleResult.user.id,
      bookGuid,
      defaultKind,
    });

    return NextResponse.json({ sender: serializeSender(sender) }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message.includes('already on the allowlist')) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error('Error updating email-ingest settings:', error);
    return NextResponse.json({ error: 'Failed to update email ingest settings' }, { status: 500 });
  }
}
