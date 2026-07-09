// src/app/api/business/billterms/[guid]/route.ts
//
// Bill terms update/delete. DELETE hides (invisible=1) when the terms are
// referenced by customers/vendors/invoices; otherwise hard-deletes.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  updateBillterm,
  deleteBillterm,
  billtermInputSchema,
  parseInput,
  BusinessValidationError,
} from '@/lib/services/business.service';

/** PUT /api/business/billterms/{guid} — full update (same body as POST). */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const body = await request.json().catch(() => null);
    const input = parseInput(billtermInputSchema, body);
    const billterm = await updateBillterm(guid, input);
    if (!billterm) {
      return NextResponse.json({ error: 'Bill terms not found' }, { status: 404 });
    }
    return NextResponse.json(billterm);
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error updating bill terms:', error);
    return NextResponse.json({ error: 'Failed to update bill terms' }, { status: 500 });
  }
}

/**
 * DELETE /api/business/billterms/{guid}
 * Hard-deletes only when unreferenced; otherwise sets invisible=1.
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
    const result = await deleteBillterm(guid);
    if (!result) {
      return NextResponse.json({ error: 'Bill terms not found' }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error deleting bill terms:', error);
    return NextResponse.json({ error: 'Failed to delete bill terms' }, { status: 500 });
  }
}
