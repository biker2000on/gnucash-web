// src/app/api/business/funds/route.ts
//
// Restricted funds: list (+ report view) and create. Book-scoped.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { mapFundError } from '@/lib/business/api-errors';
import { listFunds, createFund, fundReport } from '@/lib/services/funds.service';

/**
 * GET /api/business/funds — fund list.
 * GET /api/business/funds?view=report&startDate=&endDate= — per-fund report
 * (period income/expense/net plus net assets to date, incl. 'Unassigned').
 */
export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const bookGuid = await getActiveBookGuid();

    if (searchParams.get('view') === 'report') {
      const report = await fundReport(bookGuid, {
        startDate: searchParams.get('startDate'),
        endDate: searchParams.get('endDate'),
      });
      return NextResponse.json(report);
    }

    return NextResponse.json(await listFunds(bookGuid));
  } catch (error) {
    return mapFundError(error);
  }
}

/**
 * POST /api/business/funds
 * Body: { name, restriction?, description?, active?, sortOrder? }.
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const bookGuid = await getActiveBookGuid();
    const fund = await createFund(bookGuid, body);
    return NextResponse.json(fund, { status: 201 });
  } catch (error) {
    return mapFundError(error);
  }
}
