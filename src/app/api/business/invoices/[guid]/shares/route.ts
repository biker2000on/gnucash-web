// src/app/api/business/invoices/[guid]/shares/route.ts
//
// Customer-facing share links for an invoice. Creation, listing, and
// revocation are book-scoped (fetch-then-check in the service).

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { mapInvoiceError } from '@/lib/business/api-errors';
import {
  createInvoiceShare,
  listInvoiceShares,
  revokeInvoiceShare,
} from '@/lib/business/invoice-shares.service';

/** GET /api/business/invoices/[guid]/shares — all share links for the invoice. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const bookGuid = await getActiveBookGuid();
    const shares = await listInvoiceShares(bookGuid, guid);
    return NextResponse.json({ shares });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/**
 * POST /api/business/invoices/[guid]/shares — create a share link.
 * Body: { expiresInDays?: number|null } — omitted/null => never expires.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const body = await request.json().catch(() => ({}));
    const raw = body?.expiresInDays;
    const expiresInDays =
      raw === null || raw === undefined ? null : Number.isInteger(raw) && raw > 0 ? raw : null;

    const bookGuid = await getActiveBookGuid();
    const share = await createInvoiceShare(bookGuid, guid, expiresInDays);
    return NextResponse.json({ share }, { status: 201 });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/**
 * DELETE /api/business/invoices/[guid]/shares?token=... — revoke a link.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    await params; // guid unused: tokens are globally unique, book-checked below
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
