// src/app/api/business/customers/route.ts
//
// Customer list + create. NOTE: the native GnuCash business tables have no
// book_guid column, so customers are unscoped (single-business-database
// assumption) — see src/lib/services/business.service.ts.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  listCustomers,
  createCustomer,
  customerInputSchema,
  parseInput,
  BusinessValidationError,
  type ContactListOptions,
} from '@/lib/services/business.service';

/**
 * GET /api/business/customers
 * Query params: search (matches name/id/email), active (active|inactive|all).
 */
export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const activeParam = searchParams.get('active');
    const options: ContactListOptions = {
      search: searchParams.get('search')?.trim() || undefined,
      active: activeParam === 'active' || activeParam === 'inactive' ? activeParam : 'all',
    };

    return NextResponse.json(await listCustomers(options));
  } catch (error) {
    console.error('Error listing customers:', error);
    return NextResponse.json({ error: 'Failed to list customers' }, { status: 500 });
  }
}

/**
 * POST /api/business/customers
 * Body: { name, notes?, active?, currency?, discount?, credit?, taxOverride?,
 *         taxIncluded?, address?, shipAddress?, terms?, taxtable? }.
 * The human-readable id ('000001') is assigned automatically.
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => null);
    const input = parseInput(customerInputSchema, body);
    const customer = await createCustomer(input);
    return NextResponse.json(customer, { status: 201 });
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error creating customer:', error);
    return NextResponse.json({ error: 'Failed to create customer' }, { status: 500 });
  }
}
