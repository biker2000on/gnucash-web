// src/app/api/business/employees/route.ts
//
// Employee list + create. NOTE: like the other native GnuCash business
// tables, employees have no book_guid column and are unscoped
// (single-business-database assumption) — see
// src/lib/business/employees.service.ts.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { parseInput, BusinessValidationError } from '@/lib/services/business.service';
import {
  listEmployees,
  createEmployee,
  employeeInputSchema,
  type EmployeeListOptions,
} from '@/lib/business/employees.service';

/**
 * GET /api/business/employees
 * Query params: search (username/id/name/email), active (active|inactive|all).
 */
export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const activeParam = searchParams.get('active');
    const options: EmployeeListOptions = {
      search: searchParams.get('search')?.trim() || undefined,
      active: activeParam === 'active' || activeParam === 'inactive' ? activeParam : 'all',
    };

    return NextResponse.json(await listEmployees(options));
  } catch (error) {
    console.error('Error listing employees:', error);
    return NextResponse.json({ error: 'Failed to list employees' }, { status: 500 });
  }
}

/**
 * POST /api/business/employees
 * Body: { username, language?, active?, currency?, workday?, rate?, address? }.
 * The human-readable id ('000001') is assigned automatically.
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => null);
    const input = parseInput(employeeInputSchema, body);
    const employee = await createEmployee(input);
    return NextResponse.json(employee, { status: 201 });
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error creating employee:', error);
    return NextResponse.json({ error: 'Failed to create employee' }, { status: 500 });
  }
}
