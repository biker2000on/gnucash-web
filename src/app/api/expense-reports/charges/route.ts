// src/app/api/expense-reports/charges/route.ts
//
// Household side (active book = household).
// GET ?business=&view=candidates|markable[&search=&days=&all=1]
//   candidates: charges on the reimbursable account with something left to
//               report (all=1 includes fully reported ones).
//   markable:   recent expense charges that could be moved onto it.
// POST { businessBookGuid, action: 'mark'|'personal', splitGuid, cents?,
//        personalAccountGuid?, dryRun? } rewrites one household transaction
//   (preview with dryRun). 'personal' records the part split off.

import { NextRequest, NextResponse } from 'next/server';
import { listCandidates, listMarkable, markForReimbursement, markPersonal } from '@/lib/expense-reports/household';
import { ExpenseReportError } from '@/lib/expense-reports/shared';
import { cents, errorResponse, readJson, requiredStr, routeContext, str } from '@/lib/expense-reports/http';

export async function GET(request: NextRequest) {
  try {
    const ctx = await routeContext('readonly');
    if (ctx instanceof NextResponse) return ctx;
    const params = request.nextUrl.searchParams;
    const business = requiredStr(params.get('business'), 'business');
    if (params.get('view') === 'markable') {
      const days = Number(params.get('days') ?? '120');
      return NextResponse.json({
        charges: await listMarkable(ctx.bookGuid, business, {
          days: Number.isFinite(days) ? days : 120,
          search: str(params.get('search')),
        }),
      });
    }
    return NextResponse.json(await listCandidates(ctx.bookGuid, business, { includeAllocated: params.get('all') === '1' }));
  } catch (error) {
    return errorResponse(error, 'Failed to load charges');
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await routeContext('edit');
    if (ctx instanceof NextResponse) return ctx;
    const body = await readJson(request);
    const common = {
      householdBookGuid: ctx.bookGuid,
      businessBookGuid: requiredStr(body.businessBookGuid, 'businessBookGuid'),
      splitGuid: requiredStr(body.splitGuid, 'splitGuid'),
      dryRun: body.dryRun === true,
    };
    if (body.action === 'mark') {
      return NextResponse.json(
        await markForReimbursement(ctx, { ...common, cents: body.cents === undefined ? undefined : cents(body.cents) })
      );
    }
    if (body.action === 'personal') {
      return NextResponse.json(
        await markPersonal(ctx, {
          ...common,
          cents: cents(body.cents),
          personalAccountGuid: requiredStr(body.personalAccountGuid, 'personalAccountGuid'),
        })
      );
    }
    throw new ExpenseReportError("action must be 'mark' or 'personal'.");
  } catch (error) {
    return errorResponse(error, 'Failed to update the charge');
  }
}
