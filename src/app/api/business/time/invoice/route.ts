// src/app/api/business/time/invoice/route.ts
//
// Turn selected unbilled time entries into a DRAFT invoice (one line per
// entry: description, hours x rate on the chosen income account), then mark
// the entries invoiced with the new invoice guid.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { parseInput, BusinessValidationError } from '@/lib/services/business.service';
import { generateInvoiceLines } from '@/lib/business/time-tracking.service';
import { mapTimeTrackingError } from '@/lib/business/time-tracking-errors';

const GUID_RE = /^[0-9a-f]{32}$/;

const invoiceSchema = z.object({
  customerGuid: z.string().regex(GUID_RE),
  entryIds: z.array(z.number().int().positive()).min(1),
  incomeAccountGuid: z.string().regex(GUID_RE),
});

/**
 * POST /api/business/time/invoice
 * Body: { customerGuid, entryIds, incomeAccountGuid }.
 * Returns { invoice, entryIds } — the invoice stays a draft for review.
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const body = await request.json().catch(() => null);
    const input = parseInput(invoiceSchema, body);
    const result = await generateInvoiceLines(
      bookGuid,
      input.customerGuid,
      input.entryIds,
      input.incomeAccountGuid,
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return mapTimeTrackingError(error, 'invoicing time entries');
  }
}
