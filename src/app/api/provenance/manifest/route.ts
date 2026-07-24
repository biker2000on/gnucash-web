import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listCalculationTraces } from '@/lib/provenance';
import {
  listActionTraceSnapshots,
  MAX_ACTION_TRACE_EXPORT,
} from '@/lib/financial-actions/store';
import { MAX_TRACES_PER_BOOK } from '@/lib/provenance';

export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const [traces, actions] = await Promise.all([
      listCalculationTraces(roleResult.user.id, roleResult.bookGuid),
      listActionTraceSnapshots({
        userId: roleResult.user.id,
        bookGuid: roleResult.bookGuid,
      }),
    ]);
    const manifest = {
      schema: 'gnucash-web.calculation-manifest.v1',
      bookGuid: roleResult.bookGuid,
      exportedAt: new Date().toISOString(),
      retentionPolicy: {
        calculationTracesPerUserBook: MAX_TRACES_PER_BOOK,
        actionTracesPerExport: MAX_ACTION_TRACE_EXPORT,
      },
      traceCount: traces.length,
      traces,
      actionTraceCount: actions.traces.length,
      actionTraceTruncated: actions.truncated,
      actions: actions.traces,
    };
    if (request.nextUrl.searchParams.get('download') === 'true') {
      return new NextResponse(JSON.stringify(manifest, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="financial-evidence-${new Date().toISOString().slice(0, 10)}.json"`,
        },
      });
    }
    return NextResponse.json(manifest);
  } catch (error) {
    console.error('Error exporting calculation manifest:', error);
    return NextResponse.json({ error: 'Failed to export calculation manifest' }, { status: 500 });
  }
}
