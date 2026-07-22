import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { backfillIndexPrices } from '@/lib/market-index-service';
import { jobProgressEmitter } from '@/lib/job-progress';

export async function POST() {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const jobId = `inline-${randomUUID()}`;
    const emit = jobProgressEmitter({
      jobId,
      kind: 'backfill-indices',
      bookGuid,
      userId: user.id,
      source: 'manual',
      label: 'Index backfill',
    });

    void emit.running('Backfilling market index history…');
    try {
      const results = await backfillIndexPrices();
      const totalStored = results.reduce((sum, r) => sum + r.stored, 0);
      void emit.completed({ totalStored, indices: results.length });

      return NextResponse.json({
        success: true,
        totalStored,
        results,
        jobId,
      });
    } catch (error) {
      void emit.failed(error instanceof Error ? error.message : String(error));
      throw error;
    }
  } catch (error) {
    console.error('Index backfill failed:', error);
    return NextResponse.json(
      { error: 'Failed to backfill index prices' },
      { status: 500 }
    );
  }
}
