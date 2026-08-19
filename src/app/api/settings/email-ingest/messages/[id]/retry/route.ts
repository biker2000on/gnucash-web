import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { hasTargetBookRole } from '@/lib/target-book-auth';
import { enqueueJob } from '@/lib/queue/queues';
import { getEmailIngestConfig, requestIngestRetry } from '@/lib/email-ingest';

/**
 * POST /api/settings/email-ingest/messages/[id]/retry — re-arm one terminally
 * failed ingest message so the next mailbox poll re-fetches and reprocesses it.
 *
 * AUTHORIZATION is the message's own immutable owner snapshot, never the
 * (mutable) sender allowlist: the caller must be the snapshotted owner, or an
 * admin of the snapshotted book. A message with no snapshot cannot be
 * re-attributed safely and is refused with that reason — see
 * `requestIngestRetry`, which also decides what may be revealed to whom (a row
 * the caller cannot see at all is reported as 404, not 403, so this endpoint is
 * not an oracle for other users' inbound mail).
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    if (!getEmailIngestConfig()) {
      return NextResponse.json(
        { error: 'Email ingest is not configured (set INGEST_IMAP_* env vars)' },
        { status: 400 },
      );
    }

    const { id: idRaw } = await params;
    const id = parseInt(idRaw, 10);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: 'Invalid message id' }, { status: 400 });
    }

    const outcome = await requestIngestRetry(id, roleResult.user.id, {
      // Escalation for a book admin, checked against the SNAPSHOTTED book.
      canAdministerBook: bookGuid => hasTargetBookRole(roleResult, bookGuid, 'admin'),
    });

    if (!outcome.ok) {
      if (outcome.reason === 'not_found') {
        return NextResponse.json({ error: 'Ingest message not found' }, { status: 404 });
      }
      if (outcome.reason === 'cooldown') {
        return NextResponse.json(
          { error: `Too soon — try again in about ${outcome.retryAfterMinutes} minute(s)` },
          { status: 429, headers: { 'Retry-After': String(outcome.retryAfterMinutes * 60) } },
        );
      }
      return NextResponse.json({ error: outcome.detail }, { status: 409 });
    }

    // Kick a poll so the retry happens now rather than on the next tick. The
    // manual-retry cooldown enforced above is what rate-limits this.
    const jobId = await enqueueJob('poll-email-ingest');
    return NextResponse.json({ retried: true, enqueued: jobId !== null });
  } catch (error) {
    console.error('Error re-arming ingest message:', error);
    return NextResponse.json({ error: 'Failed to retry the message' }, { status: 500 });
  }
}
