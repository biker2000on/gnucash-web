import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getAiConfig } from '@/lib/ai-config';
import { enqueueJob } from '@/lib/queue/queues';
import { countReceiptReextractCandidates } from '@/lib/receipt-reextract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const roleResult = await requireRole('admin');
  if (roleResult instanceof NextResponse) return roleResult;

  try {
    const [config, eligible] = await Promise.all([
      getAiConfig(roleResult.user.id),
      countReceiptReextractCandidates(roleResult.bookGuid),
    ]);
    const aiConfigured = Boolean(config?.enabled && config.base_url && config.model);
    return NextResponse.json({ allowed: true, aiConfigured, eligible });
  } catch (error) {
    console.error('Failed to load receipt re-extraction status:', error);
    return NextResponse.json(
      { error: 'Failed to load receipt re-extraction status.' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const roleResult = await requireRole('admin');
  if (roleResult instanceof NextResponse) return roleResult;

  try {
    const body = await request.json().catch(() => ({}));
    const force = body?.force === true;
    const config = await getAiConfig(roleResult.user.id);
    if (!config?.enabled || !config.base_url || !config.model) {
      return NextResponse.json(
        { error: 'Configure and enable AI extraction before starting this job.' },
        { status: 409 },
      );
    }

    const eligible = await countReceiptReextractCandidates(roleResult.bookGuid, force);
    if (eligible === 0) {
      return NextResponse.json({
        jobId: null,
        eligible: 0,
        message: 'No receipts need re-extraction.',
      });
    }

    const jobId = await enqueueJob('reextract-receipts', {
      bookGuid: roleResult.bookGuid,
      userId: roleResult.user.id,
      source: 'manual',
      force,
    });
    if (!jobId) {
      return NextResponse.json(
        { error: 'The background job queue is unavailable.' },
        { status: 503 },
      );
    }

    return NextResponse.json({ jobId, eligible }, { status: 202 });
  } catch (error) {
    console.error('Failed to enqueue receipt re-extraction:', error);
    return NextResponse.json(
      { error: 'Failed to enqueue receipt re-extraction.' },
      { status: 500 },
    );
  }
}
