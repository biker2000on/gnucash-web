// src/app/api/business/packages/[id]/route.ts
//
// Single package read/update/void. Book-scoped fetch-then-check in the service.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { mapPackageError } from '@/lib/business/api-errors';
import { getPackage, updatePackage, deletePackage } from '@/lib/services/packages.service';

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /api/business/packages/{id} — package with redemption history. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: rawId } = await params;
    const id = parseId(rawId);
    if (!id) return NextResponse.json({ error: 'Invalid package id' }, { status: 400 });

    const bookGuid = await getActiveBookGuid();
    return NextResponse.json(await getPackage(bookGuid, id));
  } catch (error) {
    return mapPackageError(error);
  }
}

/** PUT /api/business/packages/{id} — update name/client/customer/notes. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: rawId } = await params;
    const id = parseId(rawId);
    if (!id) return NextResponse.json({ error: 'Invalid package id' }, { status: 400 });

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const bookGuid = await getActiveBookGuid();
    return NextResponse.json(await updatePackage(bookGuid, id, body));
  } catch (error) {
    return mapPackageError(error);
  }
}

/**
 * DELETE /api/business/packages/{id} — voids the package: removes the sale
 * transaction, every redemption transaction, and the package row.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: rawId } = await params;
    const id = parseId(rawId);
    if (!id) return NextResponse.json({ error: 'Invalid package id' }, { status: 400 });

    const bookGuid = await getActiveBookGuid();
    await deletePackage(bookGuid, id);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return mapPackageError(error);
  }
}
