import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  getCustomerStatement,
  StatementNotFoundError,
} from '@/lib/business/customer-statement';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/business/customers/[guid]/statement?startDate&endDate
 *   - endDate defaults to today; startDate omitted => opening balance 0 and
 *     activity from the beginning.
 * Response: { customer, period, openingBalance, activity, closingBalance, aging }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> },
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const { searchParams } = new URL(request.url);
    const rawStart = searchParams.get('startDate');
    const rawEnd = searchParams.get('endDate');
    if (rawStart && !ISO_DATE_RE.test(rawStart)) {
      return NextResponse.json({ error: 'startDate must be YYYY-MM-DD' }, { status: 400 });
    }
    if (rawEnd && !ISO_DATE_RE.test(rawEnd)) {
      return NextResponse.json({ error: 'endDate must be YYYY-MM-DD' }, { status: 400 });
    }
    const endDate = rawEnd ?? new Date().toISOString().slice(0, 10);
    const startDate = rawStart ?? null;
    if (startDate && startDate > endDate) {
      return NextResponse.json({ error: 'startDate must be on or before endDate' }, { status: 400 });
    }

    const statement = await getCustomerStatement(guid, startDate, endDate);
    return NextResponse.json(statement);
  } catch (error) {
    if (error instanceof StatementNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error('Customer statement error:', error);
    return NextResponse.json({ error: 'Failed to build the statement' }, { status: 500 });
  }
}
