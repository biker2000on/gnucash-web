import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import {
  getEmployee,
  generateEmployeeVoucherSummary,
} from '@/lib/business/employees.service';

/**
 * GET /api/business/employees/{guid}/report — per-employee voucher summary:
 * posted totals, outstanding (unreimbursed), paid, and a per-month breakdown
 * (posted vouchers book-scoped via post_acc).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const employee = await getEmployee(guid);
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    const bookAccountGuids = await getBookAccountGuids();
    const summary = await generateEmployeeVoucherSummary(guid, bookAccountGuids);
    return NextResponse.json({ employee, summary });
  } catch (error) {
    console.error('Error generating employee report:', error);
    return NextResponse.json({ error: 'Failed to generate employee report' }, { status: 500 });
  }
}
