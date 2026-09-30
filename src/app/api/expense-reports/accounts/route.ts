// src/app/api/expense-reports/accounts/route.ts
//
// Account (and employee) lists for cross-book pickers: the settings panel on
// one side of a link needs accounts from the other book.
// GET ?book=<guid>&types=EXPENSE,ASSET   → { accounts: [{ guid, path, type }] }
// GET ?book=<guid>&employees=1           → { employees: [{ guid, name }] }

import { NextRequest, NextResponse } from 'next/server';
import { listBookAccounts, listBusinessEmployees } from '@/lib/expense-reports/overview';
import { errorResponse, requiredStr, routeContext } from '@/lib/expense-reports/http';

const ALLOWED_TYPES = new Set([
  'EXPENSE', 'ASSET', 'BANK', 'CASH', 'CREDIT', 'RECEIVABLE', 'EQUITY', 'LIABILITY', 'INCOME',
]);

export async function GET(request: NextRequest) {
  try {
    const ctx = await routeContext('readonly');
    if (ctx instanceof NextResponse) return ctx;
    const params = request.nextUrl.searchParams;
    const book = requiredStr(params.get('book'), 'book');
    if (params.get('employees') === '1') {
      return NextResponse.json({ employees: await listBusinessEmployees(ctx, book) });
    }
    const types = (params.get('types') ?? 'EXPENSE')
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter((t) => ALLOWED_TYPES.has(t));
    return NextResponse.json({ accounts: await listBookAccounts(ctx, book, types) });
  } catch (error) {
    return errorResponse(error, 'Failed to load accounts');
  }
}
