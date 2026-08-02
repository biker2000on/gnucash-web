import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listBatches } from '@/lib/services/statement.service';
import { roleAtLeast } from '@/lib/services/permission.service';

/** GET /api/statements — list statement batches for the active book. */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const batches = await listBatches(bookGuid);
    let recoveryQueued: number[] = [];
    if (roleAtLeast(roleResult.role, 'edit')) {
      try {
        const { scheduleStatementRecovery } = await import('@/lib/queue/statement-recovery');
        recoveryQueued = await scheduleStatementRecovery({
          batches,
          bookGuid,
          userId: roleResult.user.id,
        });
      } catch (recoveryError) {
        console.warn('Automatic statement recovery scheduling failed:', recoveryError);
      }
    }
    return NextResponse.json({ batches, recoveryQueued });
  } catch (error) {
    console.error('Statement list error:', error);
    return NextResponse.json({ error: 'Failed to list statements' }, { status: 500 });
  }
}
