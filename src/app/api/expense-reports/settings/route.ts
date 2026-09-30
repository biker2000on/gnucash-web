// src/app/api/expense-reports/settings/route.ts
//
// Per book-link settings. GET ?business=&household= ; PUT body:
// { businessBookGuid, householdBookGuid, ...fields }. Household fields need
// edit on the household book, business fields edit on the business book.
// POST { businessBookGuid, householdBookGuid, ownerName } creates the owner's
// employee record in the business book and enables Employees & Vouchers.

import { NextRequest, NextResponse } from 'next/server';
import { getSettings, requireBookRead, saveSettings, ExpenseReportError } from '@/lib/expense-reports/shared';
import { setupOwnerEmployee } from '@/lib/expense-reports/overview';
import { errorResponse, optionalGuid, readJson, requiredStr, routeContext } from '@/lib/expense-reports/http';

export async function GET(request: NextRequest) {
  try {
    const ctx = await routeContext('readonly');
    if (ctx instanceof NextResponse) return ctx;
    const business = requiredStr(request.nextUrl.searchParams.get('business'), 'business');
    const household = requiredStr(request.nextUrl.searchParams.get('household'), 'household');
    if (ctx.bookGuid !== business && ctx.bookGuid !== household) {
      throw new ExpenseReportError('Open one of the linked books first.', 403);
    }
    await requireBookRead(ctx, ctx.bookGuid === business ? household : business, 'linked');
    return NextResponse.json(await getSettings(business, household));
  } catch (error) {
    return errorResponse(error, 'Failed to load expense report settings');
  }
}

export async function PUT(request: NextRequest) {
  try {
    const ctx = await routeContext('edit');
    if (ctx instanceof NextResponse) return ctx;
    const body = await readJson(request);
    const business = requiredStr(body.businessBookGuid, 'businessBookGuid');
    const household = requiredStr(body.householdBookGuid, 'householdBookGuid');
    if (ctx.bookGuid !== business && ctx.bookGuid !== household) {
      throw new ExpenseReportError('Open one of the linked books first.', 403);
    }
    const deadline = body.submissionDeadlineDays;
    return NextResponse.json(
      await saveSettings(ctx, business, household, {
        reimbursableAccountGuid: optionalGuid(body.reimbursableAccountGuid),
        employeeGuid: optionalGuid(body.employeeGuid),
        settlementMode:
          body.settlementMode === 'reimburse' || body.settlementMode === 'contribution'
            ? body.settlementMode
            : undefined,
        contributionAccountGuid: optionalGuid(body.contributionAccountGuid),
        householdInvestmentAccountGuid: optionalGuid(body.householdInvestmentAccountGuid),
        householdDepositAccountGuid: optionalGuid(body.householdDepositAccountGuid),
        paymentAccountGuid: optionalGuid(body.paymentAccountGuid),
        submissionDeadlineDays: typeof deadline === 'number' ? deadline : undefined,
        reportSince:
          body.reportSince === undefined ? undefined : typeof body.reportSince === 'string' && body.reportSince ? body.reportSince : null,
      })
    );
  } catch (error) {
    return errorResponse(error, 'Failed to save expense report settings');
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await routeContext('edit');
    if (ctx instanceof NextResponse) return ctx;
    const body = await readJson(request);
    const business = requiredStr(body.businessBookGuid, 'businessBookGuid');
    const household = requiredStr(body.householdBookGuid, 'householdBookGuid');
    if (ctx.bookGuid !== business && ctx.bookGuid !== household) {
      throw new ExpenseReportError('Open one of the linked books first.', 403);
    }
    return NextResponse.json(
      await setupOwnerEmployee(ctx, business, household, requiredStr(body.ownerName, 'ownerName')),
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error, 'Failed to set up the owner employee');
  }
}
