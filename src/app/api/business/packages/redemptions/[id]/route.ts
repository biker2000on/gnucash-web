// src/app/api/business/packages/redemptions/[id]/route.ts
//
// Delete a redemption — removes its recognition transaction too, restoring
// the deferred-revenue liability. Book-scoped fetch-then-check in the service.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { mapPackageError } from '@/lib/business/api-errors';
import { deleteRedemption } from '@/lib/services/packages.service';

/** DELETE /api/business/packages/redemptions/{id} */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: rawId } = await params;
    const id = parseInt(rawId, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid redemption id' }, { status: 400 });
    }

    const bookGuid = await getActiveBookGuid();
    await deleteRedemption(bookGuid, id);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return mapPackageError(error);
  }
}
