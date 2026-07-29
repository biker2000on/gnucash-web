import { NextRequest, NextResponse } from 'next/server';
import { requireTimesheetRole } from '@/lib/auth';
import {
  employeeForUsername,
  listReimbursements,
  submitReimbursement,
  ReimbursementValidationError,
  type ReimbursementStatus,
} from '@/lib/business/reimbursements';

const STATUSES = new Set<ReimbursementStatus>(['submitted', 'approved', 'posted', 'rejected']);

export async function GET(request: NextRequest) {
  try {
    const auth = await requireTimesheetRole('read');
    if (auth instanceof NextResponse) return auth;
    const requestedEmployee = request.nextUrl.searchParams.get('employeeGuid') || undefined;
    const ownEmployee = auth.isTimekeeper ? await employeeForUsername(auth.user.username) : null;
    if (auth.isTimekeeper && !ownEmployee) {
      return NextResponse.json({ error: 'No active employee record matches your username' }, { status: 403 });
    }
    const statusParam = request.nextUrl.searchParams.get('status');
    const status = statusParam && STATUSES.has(statusParam as ReimbursementStatus)
      ? statusParam as ReimbursementStatus
      : undefined;
    return NextResponse.json({
      requests: await listReimbursements({
        bookGuid: auth.bookGuid,
        status,
        employeeGuid: ownEmployee ?? requestedEmployee,
      }),
    });
  } catch (error) {
    console.error('Error listing reimbursement requests:', error);
    return NextResponse.json({ error: 'Failed to list reimbursement requests' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireTimesheetRole('write');
    if (auth instanceof NextResponse) return auth;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: 'Request body is required' }, { status: 400 });

    const ownEmployee = auth.isTimekeeper ? await employeeForUsername(auth.user.username) : null;
    if (auth.isTimekeeper && !ownEmployee) {
      return NextResponse.json({ error: 'No active employee record matches your username' }, { status: 403 });
    }
    const employeeGuid = ownEmployee ?? (typeof body.employeeGuid === 'string' ? body.employeeGuid : '');
    const requestRow = await submitReimbursement({
      bookGuid: auth.bookGuid,
      submittedBy: auth.user.id,
      receiptCreatedBy: auth.isTimekeeper ? auth.user.id : undefined,
      employeeGuid,
      receiptId: typeof body.receiptId === 'number' ? body.receiptId : null,
      amount: Number(body.amount),
      expenseAccountGuid: typeof body.expenseAccountGuid === 'string' ? body.expenseAccountGuid : '',
      description: typeof body.description === 'string' ? body.description : undefined,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      expenseDate: typeof body.expenseDate === 'string' ? body.expenseDate : '',
      dueDate: typeof body.dueDate === 'string' ? body.dueDate : null,
    });
    return NextResponse.json({ request: requestRow }, { status: 201 });
  } catch (error) {
    if (error instanceof ReimbursementValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error submitting reimbursement:', error);
    return NextResponse.json({ error: 'Failed to submit reimbursement' }, { status: 500 });
  }
}
