// src/app/api/business/taxtables/[guid]/route.ts
//
// Tax table update/delete. PUT replaces the full entry list. DELETE hides
// (invisible=1) when referenced by customers/vendors/entries; otherwise
// hard-deletes the table and its entries.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  updateTaxtable,
  deleteTaxtable,
  taxtableInputSchema,
  parseInput,
  BusinessValidationError,
} from '@/lib/services/business.service';

/** PUT /api/business/taxtables/{guid} — full update, entries replaced. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const body = await request.json().catch(() => null);
    const input = parseInput(taxtableInputSchema, body);
    const taxtable = await updateTaxtable(guid, input);
    if (!taxtable) {
      return NextResponse.json({ error: 'Tax table not found' }, { status: 404 });
    }
    return NextResponse.json(taxtable);
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error updating tax table:', error);
    return NextResponse.json({ error: 'Failed to update tax table' }, { status: 500 });
  }
}

/**
 * DELETE /api/business/taxtables/{guid}
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
    const result = await deleteTaxtable(guid);
    if (!result) {
      return NextResponse.json({ error: 'Tax table not found' }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error deleting tax table:', error);
    return NextResponse.json({ error: 'Failed to delete tax table' }, { status: 500 });
  }
}
