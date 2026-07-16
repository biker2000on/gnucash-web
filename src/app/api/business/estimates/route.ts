// src/app/api/business/estimates/route.ts
//
// Estimates (quotes) — list + create. Book-scoped in the service.

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { mapInvoiceError } from '@/lib/business/api-errors';
import {
  listEstimates,
  createEstimate,
  ESTIMATE_STATUSES,
  type EstimateStatus,
} from '@/lib/business/estimates.service';

/** GET /api/business/estimates?status=draft|sent|accepted|declined|converted */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const status = new URL(request.url).searchParams.get('status');
    if (status && !(ESTIMATE_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 });
    }

    const bookGuid = await getActiveBookGuid();
    const estimates = await listEstimates(bookGuid, {
      status: (status as EstimateStatus) ?? undefined,
    });
    return NextResponse.json({ estimates });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/**
 * POST /api/business/estimates — create a draft estimate.
 * Body: { customerGuid?, dateCreated?, expires?, notes?, terms?,
 *         lines: [{ description?, quantity, unitPrice, incomeAccountGuid? }] }
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => null);
    if (!body || !Array.isArray(body.lines)) {
      return NextResponse.json({ error: 'lines array is required' }, { status: 400 });
    }

    const bookGuid = await getActiveBookGuid();
    const estimate = await createEstimate(bookGuid, {
      customerGuid: body.customerGuid,
      dateCreated: body.dateCreated,
      expires: body.expires,
      notes: body.notes,
      terms: body.terms,
      lines: body.lines,
    });
    return NextResponse.json({ estimate }, { status: 201 });
  } catch (error) {
    return mapInvoiceError(error);
  }
}
