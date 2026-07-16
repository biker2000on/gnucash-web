// src/app/api/business/estimates/[id]/convert/route.ts
//
// Convert an estimate into a new DRAFT customer invoice (invoice engine).
// Marks the estimate converted and records the invoice guid.

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { mapInvoiceError } from '@/lib/business/api-errors';
import { convertEstimateToInvoice } from '@/lib/business/estimates.service';

/** POST /api/business/estimates/[id]/convert */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: rawId } = await params;
    const id = parseInt(rawId, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid estimate id' }, { status: 400 });
    }

    const bookGuid = await getActiveBookGuid();
    const result = await convertEstimateToInvoice(bookGuid, id);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return mapInvoiceError(error);
  }
}
