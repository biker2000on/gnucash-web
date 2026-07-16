// src/app/api/business/estimates/[id]/share/route.ts
//
// Customer-facing share links for an estimate — same public route family as
// invoice shares (/share/invoice/[token]), payload type 'estimate'.

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { mapInvoiceError } from '@/lib/business/api-errors';
import {
  createEstimateShare,
  listEstimateShares,
  revokeInvoiceShare,
} from '@/lib/business/invoice-shares.service';

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /api/business/estimates/[id]/share — all share links for the estimate. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: rawId } = await params;
    const id = parseId(rawId);
    if (!id) return NextResponse.json({ error: 'Invalid estimate id' }, { status: 400 });

    const bookGuid = await getActiveBookGuid();
    const shares = await listEstimateShares(bookGuid, id);
    return NextResponse.json({ shares });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/**
 * POST /api/business/estimates/[id]/share — create a share link.
 * Body: { expiresInDays?: number|null }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: rawId } = await params;
    const id = parseId(rawId);
    if (!id) return NextResponse.json({ error: 'Invalid estimate id' }, { status: 400 });

    const body = await request.json().catch(() => ({}));
    const raw = body?.expiresInDays;
    const expiresInDays =
      raw === null || raw === undefined ? null : Number.isInteger(raw) && raw > 0 ? raw : null;

    const bookGuid = await getActiveBookGuid();
    const share = await createEstimateShare(bookGuid, id, expiresInDays);
    return NextResponse.json({ share }, { status: 201 });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/** DELETE /api/business/estimates/[id]/share?token=... — revoke a link. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    await params;
    const token = new URL(request.url).searchParams.get('token');
    if (!token) {
      return NextResponse.json({ error: 'token query parameter is required' }, { status: 400 });
    }

    const bookGuid = await getActiveBookGuid();
    await revokeInvoiceShare(bookGuid, token);
    return NextResponse.json({ revoked: true });
  } catch (error) {
    return mapInvoiceError(error);
  }
}
