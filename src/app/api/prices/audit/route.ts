import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { enqueueJob } from '@/lib/queue/queues';
import { auditAndBackfillPrices } from '@/lib/price-service';

const AuditPricesSchema = z.object({
  symbols: z.array(z.string()).optional(),
  async: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    let symbols: string[] | undefined;
    let runAsync = true;

    const contentType = request.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      const body = await request.json().catch(() => ({}));
      const parseResult = AuditPricesSchema.safeParse(body);

      if (!parseResult.success) {
        return NextResponse.json(
          { error: 'Validation failed', errors: parseResult.error.issues },
          { status: 400 }
        );
      }

      symbols = parseResult.data.symbols;
      runAsync = parseResult.data.async ?? true;
    }

    if (runAsync) {
      const jobId = await enqueueJob('audit-price-history', symbols ? { symbols } : {});
      if (jobId) {
        return NextResponse.json({
          queued: true,
          jobId,
          message: 'Price audit job queued',
        });
      }
    }

    const result = await auditAndBackfillPrices(symbols);

    return NextResponse.json({
      queued: false,
      stored: result.stored,
      audited: result.audited,
      failed: result.failed,
      results: result.results,
    });
  } catch (error) {
    console.error('Error auditing historical prices:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: `Failed to audit historical prices: ${message}` },
      { status: 500 }
    );
  }
}
