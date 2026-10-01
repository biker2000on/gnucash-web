// src/app/api/expense-reports/[id]/route.ts
//
// GET  → the report (from either side) plus, on the business side, the
//        approval preview (blockers, totals by account).
// POST → a workflow action. Body { action, ... }:
//   business side: 'categorize' { updates: [{ lineId, expenseAccountGuid?,
//                    businessPurpose? }], rememberLineIds? }
//                  'split' { lineId, parts: [{ cents, expenseAccountGuid }] }
//                  'approve' { postDate?, dueDate?, dryRun? }
//                  'recategorize' { updates: [{ lineId, expenseAccountGuid?, description?, businessPurpose? }], dryRun? }
//                  'pay' { paymentAccountGuid, date?, num? }
//                  'contribute' { contributionAccountGuid, householdInvestmentAccountGuid, date? }
//                    (settle an approved report as a capital contribution; edit on both books)
//                  'reject' { reason }
//   household side: 'withdraw'
//   either side (household edit required): 'settle' { depositAccountGuid,
//                    date?, matchTxGuid?, dryRun? }

import { NextRequest, NextResponse } from 'next/server';
import { getReportView } from '@/lib/expense-reports/overview';
import {
  approveReport,
  payReport,
  previewApproval,
  recategorizePostedReport,
  rejectReport,
  settleHousehold,
  settlePostedAsContribution,
  splitReportLine,
  updateReportLines,
} from '@/lib/expense-reports/business';
import { withdrawReport } from '@/lib/expense-reports/household';
import { ExpenseReportError } from '@/lib/expense-reports/shared';
import {
  cents,
  errorResponse,
  isoDate,
  optionalGuid,
  readJson,
  reportId,
  requiredStr,
  routeContext,
  str,
} from '@/lib/expense-reports/http';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const ctx = await routeContext('readonly');
    if (ctx instanceof NextResponse) return ctx;
    const id = reportId((await params).id);
    const report = await getReportView(ctx, ctx.bookGuid, id);
    const approval =
      report.side === 'business' && report.status === 'submitted' && ctx.role !== 'readonly'
        ? await previewApproval(ctx, ctx.bookGuid, id).catch(() => null)
        : null;
    return NextResponse.json({ report, approval });
  } catch (error) {
    return errorResponse(error, 'Failed to load the expense report');
  }
}

function lineUpdates(raw: unknown) {
  if (!Array.isArray(raw)) throw new ExpenseReportError('updates must be an array.');
  return raw.map((u) => {
    const r = (u ?? {}) as Record<string, unknown>;
    const lineId = Number(r.lineId);
    if (!Number.isInteger(lineId)) throw new ExpenseReportError('Each update needs a lineId.');
    return {
      lineId,
      expenseAccountGuid: optionalGuid(r.expenseAccountGuid),
      businessPurpose: r.businessPurpose === undefined ? undefined : (str(r.businessPurpose) ?? null),
      description: typeof r.description === 'string' ? r.description : undefined,
    };
  });
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const ctx = await routeContext('edit');
    if (ctx instanceof NextResponse) return ctx;
    const id = reportId((await params).id);
    const body = await readJson(request);
    const book = ctx.bookGuid;
    switch (body.action) {
      case 'categorize': {
        const remember = Array.isArray(body.rememberLineIds)
          ? body.rememberLineIds.map(Number).filter(Number.isInteger)
          : [];
        return NextResponse.json({ report: await updateReportLines(ctx, book, id, lineUpdates(body.updates), { rememberLineIds: remember }) });
      }
      case 'split': {
        if (!Array.isArray(body.parts)) throw new ExpenseReportError('parts must be an array.');
        const parts = body.parts.map((p) => {
          const r = (p ?? {}) as Record<string, unknown>;
          return { cents: cents(r.cents), expenseAccountGuid: optionalGuid(r.expenseAccountGuid) ?? null };
        });
        return NextResponse.json({ report: await splitReportLine(ctx, book, id, Number(body.lineId), parts) });
      }
      case 'approve': {
        const postDate = isoDate(body.postDate, 'postDate');
        if (body.dryRun === true) return NextResponse.json({ approval: await previewApproval(ctx, book, id, postDate) });
        return NextResponse.json({
          report: await approveReport(ctx, book, id, { postDate, dueDate: isoDate(body.dueDate, 'dueDate') }),
        });
      }
      case 'recategorize':
        return NextResponse.json(
          await recategorizePostedReport(ctx, book, id, lineUpdates(body.updates), { dryRun: body.dryRun === true })
        );
      case 'pay':
        return NextResponse.json({
          report: await payReport(ctx, book, id, {
            paymentAccountGuid: requiredStr(body.paymentAccountGuid, 'paymentAccountGuid'),
            date: isoDate(body.date, 'date'),
            num: str(body.num),
          }),
        });
      case 'contribute':
        return NextResponse.json({
          report: await settlePostedAsContribution(ctx, book, id, {
            contributionAccountGuid: requiredStr(body.contributionAccountGuid, 'contributionAccountGuid'),
            householdInvestmentAccountGuid: requiredStr(body.householdInvestmentAccountGuid, 'householdInvestmentAccountGuid'),
            date: isoDate(body.date, 'date'),
          }),
        });
      case 'reject':
        return NextResponse.json({ report: await rejectReport(ctx, book, id, requiredStr(body.reason, 'reason')) });
      case 'withdraw':
        return NextResponse.json({ report: await withdrawReport(ctx, book, id) });
      case 'settle':
        return NextResponse.json(
          await settleHousehold(ctx, book, id, {
            depositAccountGuid: requiredStr(body.depositAccountGuid, 'depositAccountGuid'),
            date: isoDate(body.date, 'date'),
            matchTxGuid: str(body.matchTxGuid) ?? null,
            dryRun: body.dryRun === true,
          })
        );
      default:
        throw new ExpenseReportError('Unknown action.');
    }
  } catch (error) {
    return errorResponse(error, 'Failed to update the expense report');
  }
}
