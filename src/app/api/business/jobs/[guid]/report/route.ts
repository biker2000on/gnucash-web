import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getJob } from '@/lib/services/business.service';
import { generateJobReport } from '@/lib/business/jobs.service';

/**
 * GET /api/business/jobs/{guid}/report — per-job invoice/bill rollup:
 * documents referencing the job with posted totals, paid and balance
 * (posted documents book-scoped via post_acc).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const job = await getJob(guid);
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    const bookAccountGuids = await getBookAccountGuids();
    const report = await generateJobReport(guid, bookAccountGuids);
    return NextResponse.json({ job, report });
  } catch (error) {
    console.error('Error generating job report:', error);
    return NextResponse.json({ error: 'Failed to generate job report' }, { status: 500 });
  }
}
