// src/app/api/expense-reports/badges/route.ts
//
// Ledger badges for household splits: POST { splitGuids: string[] } →
// { badges: { [splitGuid]: 'Reported · ER-3 · Paid 2026-10-05' } }. Only
// splits with an expense-report allocation appear. Scoped to the active book.

import { NextRequest, NextResponse } from 'next/server';
import { splitAllocationBadges } from '@/lib/expense-reports/household';
import { ExpenseReportError } from '@/lib/expense-reports/shared';
import { errorResponse, readJson, routeContext } from '@/lib/expense-reports/http';

export async function POST(request: NextRequest) {
  try {
    const ctx = await routeContext('readonly');
    if (ctx instanceof NextResponse) return ctx;
    const body = await readJson(request);
    const guids = Array.isArray(body.splitGuids)
      ? body.splitGuids.filter((g): g is string => typeof g === 'string' && /^[0-9a-f]{32}$/i.test(g))
      : null;
    if (!guids) throw new ExpenseReportError('splitGuids must be an array.');
    if (guids.length > 500) throw new ExpenseReportError('At most 500 splits per request.');
    return NextResponse.json({ badges: await splitAllocationBadges(ctx.bookGuid, guids) });
  } catch (error) {
    return errorResponse(error, 'Failed to load expense report badges');
  }
}
