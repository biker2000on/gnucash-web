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

    const jobId = await enqueueJob('refresh-prices', { userId: user.id, bookGuid });

    if (!jobId) {
      // No Redis configured, run directly
      const { fetchAndStorePrices } = await import('@/lib/yahoo-price-service');
      const result = await fetchAndStorePrices();

      // Check if SimpleFin sync is enabled and run it too
      let simplefinResult = null;
      try {
        const syncPref = await getPreference<string>(user.id, 'simplefin_sync_with_refresh', 'false');
        const syncEnabled = syncPref === 'true';

        if (syncEnabled) {
          const connections = await prisma.$queryRaw<{ id: number }[]>`
            SELECT id FROM gnucash_web_simplefin_connections
            WHERE user_id = ${user.id} AND book_guid = ${bookGuid}
          `;
          if (connections.length > 0) {
            const { syncSimpleFin } = await import('@/lib/services/simplefin-sync.service');
            simplefinResult = await syncSimpleFin(connections[0].id, bookGuid);
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

    return NextResponse.json({
      success: true,
      message: 'Price refresh job queued',
      jobId,
    });
  } catch (error) {
    console.error('Failed to trigger price refresh:', error);
    return NextResponse.json(
      { error: 'Failed to start price refresh' },
      { status: 500 }
    );
  }
}
