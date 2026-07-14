// src/app/api/business/packages/[id]/redemptions/route.ts
//
// Redeem sessions from a package: creates the liability → income
// recognition transaction. Book-scoped fetch-then-check in the service.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { mapPackageError } from '@/lib/business/api-errors';
import { redeemSession } from '@/lib/services/packages.service';

/**
 * POST /api/business/packages/{id}/redemptions
 * Body: { date?, sessions?, notes? } — date defaults to today, sessions to 1.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: rawId } = await params;
    const id = parseInt(rawId, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid package id' }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const bookGuid = await getActiveBookGuid();
    const pkg = await redeemSession(bookGuid, id, body ?? {});
    return NextResponse.json(pkg, { status: 201 });
  } catch (error) {
    return mapPackageError(error);
  }
}
