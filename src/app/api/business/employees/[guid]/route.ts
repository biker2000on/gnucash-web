// src/app/api/business/employees/[guid]/route.ts
//
// Single-employee read/update/delete. DELETE deactivates when vouchers
// reference the employee (invoices owner_type=5); otherwise hard-deletes.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { parseInput, BusinessValidationError } from '@/lib/services/business.service';
import {
  getEmployee,
  updateEmployee,
  deleteEmployee,
  employeeInputSchema,
} from '@/lib/business/employees.service';

/** GET /api/business/employees/{guid} */
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
    return NextResponse.json(employee);
  } catch (error) {
    console.error('Error fetching employee:', error);
    return NextResponse.json({ error: 'Failed to fetch employee' }, { status: 500 });
  }
}

/** PUT /api/business/employees/{guid} — full update (same body as POST). */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const body = await request.json().catch(() => null);
    const input = parseInput(employeeInputSchema, body);
    const employee = await updateEmployee(guid, input);
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }
    return NextResponse.json(employee);
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error updating employee:', error);
    return NextResponse.json({ error: 'Failed to update employee' }, { status: 500 });
  }
}

/**
 * DELETE /api/business/employees/{guid}
 * Hard-deletes only when unreferenced; otherwise sets active=0.
 * Returns { deleted, deactivated }.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const result = await deleteEmployee(guid);
    if (!result) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error deleting employee:', error);
    return NextResponse.json({ error: 'Failed to delete employee' }, { status: 500 });
  }
}
