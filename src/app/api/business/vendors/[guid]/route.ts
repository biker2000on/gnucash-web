// src/app/api/business/vendors/[guid]/route.ts
//
// Single-vendor read/update/delete. DELETE deactivates (active=0) when the
// vendor is referenced by jobs or bills; otherwise hard-deletes.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  getVendor,
  updateVendor,
  deleteVendor,
  vendorInputSchema,
  parseInput,
  BusinessValidationError,
} from '@/lib/services/business.service';

/** GET /api/business/vendors/{guid} */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const vendor = await getVendor(guid);
    if (!vendor) {
      return NextResponse.json({ error: 'Vendor not found' }, { status: 404 });
    }
    return NextResponse.json(vendor);
  } catch (error) {
    console.error('Error fetching vendor:', error);
    return NextResponse.json({ error: 'Failed to fetch vendor' }, { status: 500 });
  }
}

/** PUT /api/business/vendors/{guid} — full update (same body as POST). */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const body = await request.json().catch(() => null);
    const input = parseInput(vendorInputSchema, body);
    const vendor = await updateVendor(guid, input);
    if (!vendor) {
      return NextResponse.json({ error: 'Vendor not found' }, { status: 404 });
    }
    return NextResponse.json(vendor);
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error updating vendor:', error);
    return NextResponse.json({ error: 'Failed to update vendor' }, { status: 500 });
  }
}

/**
 * DELETE /api/business/vendors/{guid}
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
    const result = await deleteVendor(guid);
    if (!result) {
      return NextResponse.json({ error: 'Vendor not found' }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error deleting vendor:', error);
    return NextResponse.json({ error: 'Failed to delete vendor' }, { status: 500 });
  }
}
