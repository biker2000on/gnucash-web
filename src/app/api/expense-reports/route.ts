// src/app/api/expense-reports/route.ts
//
// Owner expense reports for the active book (either side of a book link).
// GET  → { links, reports } overview.
// POST → submit a report from the household book. Body:
//        { businessBookGuid, lines: [{ splitGuid, cents, businessPurpose? }],
//          title?, notes?, dryRun? }. A dry run returns per-line accountable-
//        plan status and category suggestions without writing.

import { NextRequest, NextResponse } from 'next/server';
import { getOverview } from '@/lib/expense-reports/overview';
import { submitReport } from '@/lib/expense-reports/household';
import { ExpenseReportError } from '@/lib/expense-reports/shared';
import { cents, errorResponse, readJson, requiredStr, routeContext, str } from '@/lib/expense-reports/http';

export async function GET() {
  try {
    const ctx = await routeContext('readonly');
    if (ctx instanceof NextResponse) return ctx;
    return NextResponse.json(await getOverview(ctx, ctx.bookGuid));
  } catch (error) {
    return errorResponse(error, 'Failed to load expense reports');
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await routeContext('edit');
    if (ctx instanceof NextResponse) return ctx;
    const body = await readJson(request);
    if (!Array.isArray(body.lines)) throw new ExpenseReportError('lines must be an array.');
    const result = await submitReport(ctx, {
      householdBookGuid: ctx.bookGuid,
      businessBookGuid: requiredStr(body.businessBookGuid, 'businessBookGuid'),
      lines: body.lines.map((raw) => {
        const l = (raw ?? {}) as Record<string, unknown>;
        return {
          splitGuid: requiredStr(l.splitGuid, 'splitGuid'),
          cents: cents(l.cents),
          businessPurpose: str(l.businessPurpose) ?? null,
        };
      }),
      title: str(body.title) ?? null,
      notes: str(body.notes) ?? null,
      dryRun: body.dryRun === true,
    });
    return NextResponse.json(result, { status: result.dryRun ? 200 : 201 });
  } catch (error) {
    return errorResponse(error, 'Failed to submit the expense report');
  }
}
