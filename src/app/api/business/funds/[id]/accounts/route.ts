// src/app/api/business/funds/[id]/accounts/route.ts
//
// Replace-style account assignment for a fund. Accounts must belong to the
// active book; accounts assigned to other funds are moved to this one.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { mapFundError } from '@/lib/business/api-errors';
import { setAccountFunds } from '@/lib/services/funds.service';

/**
 * PUT /api/business/funds/{id}/accounts
 * Body: { accountGuids: string[] } — the fund's complete account set.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: rawId } = await params;
    const id = parseInt(rawId, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid fund id' }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || !Array.isArray(body.accountGuids)) {
      return NextResponse.json({ error: 'Body must be { accountGuids: string[] }' }, { status: 400 });
    }

    const bookGuid = await getActiveBookGuid();
    return NextResponse.json(await setAccountFunds(bookGuid, id, body.accountGuids));
  } catch (error) {
    return mapFundError(error);
  }
}
