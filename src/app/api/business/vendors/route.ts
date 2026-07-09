// src/app/api/business/vendors/route.ts
//
// Vendor list + create. NOTE: the native GnuCash business tables have no
// book_guid column, so vendors are unscoped (single-business-database
// assumption) — see src/lib/services/business.service.ts.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  listVendors,
  createVendor,
  vendorInputSchema,
  parseInput,
  BusinessValidationError,
  type ContactListOptions,
} from '@/lib/services/business.service';

/**
 * GET /api/business/vendors
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

    return NextResponse.json(await listVendors(options));
  } catch (error) {
    console.error('Error listing vendors:', error);
    return NextResponse.json({ error: 'Failed to list vendors' }, { status: 500 });
  }
}

/**
 * POST /api/business/vendors
 * Body: { name, notes?, active?, currency?, taxOverride?, taxIncluded?,
 *         address?, terms?, taxtable? }.
 * The human-readable id ('000001') is assigned automatically.
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => null);
    const input = parseInput(vendorInputSchema, body);
    const vendor = await createVendor(input);
    return NextResponse.json(vendor, { status: 201 });
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error creating vendor:', error);
    return NextResponse.json({ error: 'Failed to create vendor' }, { status: 500 });
  }
}
