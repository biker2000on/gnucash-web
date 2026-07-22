import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { enqueueJob } from '@/lib/queue/queues';
import prisma from '@/lib/prisma';
import { getPreference } from '@/lib/user-preferences';

export async function POST() {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    const { user, bookGuid } = roleResult;

    const jobId = await enqueueJob('refresh-prices', { bookGuid, userId: user.id, source: 'manual' });

    if (!jobId) {
      // No Redis configured, run directly
      const { fetchAndStorePrices } = await import('@/lib/yahoo-price-service');
      const result = await fetchAndStorePrices();

      // Check if SimpleFin sync is enabled and run it too
      let simplefinResult = null;
      try {
        const connections = await prisma.$queryRaw<{ id: number; book_guid: string; user_id: number }[]>`
          SELECT id, book_guid, user_id FROM gnucash_web_simplefin_connections
          WHERE book_guid = ${bookGuid} AND sync_enabled = TRUE
        `;
        if (connections.length > 0) {
          const syncPref = await getPreference<string>(connections[0].user_id, 'simplefin_sync_with_refresh', 'false');
          if (syncPref === 'true') {
            const { syncSimpleFin } = await import('@/lib/services/simplefin-sync.service');
            simplefinResult = await syncSimpleFin(connections[0].id, connections[0].book_guid, { notifyOnSuccess: true, source: 'manual' });
          }
        }
      } catch (err) {
        console.error('SimpleFin sync during refresh failed:', err);
      }

      return NextResponse.json({
        success: true,
        message: `Refreshed ${result.stored} prices${simplefinResult ? `, imported ${simplefinResult.transactionsImported} transactions` : ''}`,
        stored: result.stored,
        backfilled: result.backfilled,
        gapsFilled: result.gapsFilled,
        failed: result.failed,
        direct: true,
        simplefin: simplefinResult ? {
          transactionsImported: simplefinResult.transactionsImported,
          transactionsSkipped: simplefinResult.transactionsSkipped,
        } : null,
      });
    }

    // The refresh-prices job no longer piggybacks SimpleFin sync (interval
    // timers own the schedule) — "Run now" still means both, so enqueue the
    // sync explicitly when the same gates pass.
    let simplefinJobId: string | undefined;
    try {
      const connections = await prisma.$queryRaw<{ id: number; user_id: number }[]>`
        SELECT id, user_id FROM gnucash_web_simplefin_connections
        WHERE book_guid = ${bookGuid} AND sync_enabled = TRUE
      `;
      if (connections.length > 0) {
        const syncPref = await getPreference<string>(connections[0].user_id, 'simplefin_sync_with_refresh', 'false');
        if (syncPref === 'true') {
          simplefinJobId = await enqueueJob('sync-simplefin', {
            connectionId: connections[0].id,
            bookGuid,
            userId: user.id,
            source: 'manual',
          });
        }
      }
    } catch (err) {
      console.error('Failed to enqueue SimpleFin sync for run-now:', err);
    }

    return NextResponse.json({
      success: true,
      message: 'Price refresh job queued',
      jobId,
      simplefinJobId: simplefinJobId ?? null,
    });
  } catch (error) {
    console.error('Failed to trigger price refresh:', error);
    return NextResponse.json(
      { error: 'Failed to start price refresh' },
      { status: 500 }
    );
  }
}
