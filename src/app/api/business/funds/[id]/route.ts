// src/app/api/business/funds/[id]/route.ts
//
// Single fund update/delete. Delete is blocked while accounts are assigned
// (deactivate instead). Book-scoped fetch-then-check in the service.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { mapFundError } from '@/lib/business/api-errors';
import { updateFund, deleteFund } from '@/lib/services/funds.service';

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** PUT /api/business/funds/{id} — update name/restriction/description/active/sortOrder. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: rawId } = await params;
    const id = parseId(rawId);
    if (!id) return NextResponse.json({ error: 'Invalid fund id' }, { status: 400 });

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const bookGuid = await getActiveBookGuid();
    return NextResponse.json(await updateFund(bookGuid, id, body));
  } catch (error) {
    return mapFundError(error);
  }
}

/** DELETE /api/business/funds/{id} — 409 while accounts are assigned. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: rawId } = await params;
    const id = parseId(rawId);
    if (!id) return NextResponse.json({ error: 'Invalid fund id' }, { status: 400 });

    const bookGuid = await getActiveBookGuid();
    await deleteFund(bookGuid, id);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return mapFundError(error);
  }
}
