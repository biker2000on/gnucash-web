import { NextResponse } from 'next/server';
import { requireTimesheetRole } from '@/lib/auth';
import { employeeForUsername } from '@/lib/business/reimbursements';
import { listEmployees } from '@/lib/business/employees.service';
import { listReceipts } from '@/lib/receipts';

export async function GET() {
  try {
    const auth = await requireTimesheetRole('write');
    if (auth instanceof NextResponse) return auth;
    const employees = await listEmployees({ active: 'active' });
    const ownEmployeeGuid = auth.isTimekeeper ? await employeeForUsername(auth.user.username) : null;
    const visibleEmployees = auth.isTimekeeper
      ? employees.filter(employee => employee.guid === ownEmployeeGuid)
      : employees;
    const receipts = await listReceipts({
      bookGuid: auth.bookGuid,
      limit: 100,
      offset: 0,
      createdBy: auth.isTimekeeper ? auth.user.id : undefined,
    });
    return NextResponse.json({
      employees: visibleEmployees,
      receipts: receipts.receipts.map(receipt => ({
        id: receipt.id,
        filename: receipt.filename,
        extractedData: receipt.extracted_data,
        createdAt: receipt.created_at,
      })),
      selfService: auth.isTimekeeper,
    });
  } catch (error) {
    console.error('Error loading reimbursement options:', error);
    return NextResponse.json({ error: 'Failed to load reimbursement options' }, { status: 500 });
  }
}
