// src/app/api/business/estimates/[id]/route.ts
//
// Single estimate read/update/delete. Book-scoped fetch-then-check in the
// service; status changes ride on PUT and are transition-validated.

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { mapInvoiceError } from '@/lib/business/api-errors';
import {
  getEstimate,
  updateEstimate,
  deleteEstimate,
} from '@/lib/business/estimates.service';

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /api/business/estimates/[id] */
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
    const estimate = await getEstimate(bookGuid, id);
    return NextResponse.json({ estimate });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/**
 * PUT /api/business/estimates/[id] — update fields, lines, and/or status.
 * Body: { customerGuid?, dateCreated?, expires?, notes?, terms?, lines?,
 *         status? } — status transitions are validated; 'converted' is only
 * reachable via POST .../convert.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: rawId } = await params;
    const id = parseId(rawId);
    if (!id) return NextResponse.json({ error: 'Invalid estimate id' }, { status: 400 });

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const bookGuid = await getActiveBookGuid();
    const estimate = await updateEstimate(bookGuid, id, {
      customerGuid: body.customerGuid,
      dateCreated: body.dateCreated,
      expires: body.expires,
      notes: body.notes,
      terms: body.terms,
      lines: body.lines,
      status: body.status,
    });
    return NextResponse.json({ estimate });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/** DELETE /api/business/estimates/[id] — delete an unconverted estimate. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: rawId } = await params;
    const id = parseId(rawId);
    if (!id) return NextResponse.json({ error: 'Invalid estimate id' }, { status: 400 });

    const bookGuid = await getActiveBookGuid();
    await deleteEstimate(bookGuid, id);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return mapInvoiceError(error);
  }
}
