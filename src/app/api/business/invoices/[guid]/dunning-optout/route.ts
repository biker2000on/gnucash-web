// src/app/api/business/invoices/[guid]/dunning-optout/route.ts
//
// Per-invoice dunning (payment reminder) opt-out toggle.

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { mapInvoiceError } from '@/lib/business/api-errors';
import { isDunningOptedOut, setDunningOptOut } from '@/lib/business/dunning';
import { isInvoiceInBook } from '@/lib/business/invoice-shares.service';
import { InvoiceNotFoundError } from '@/lib/business/invoice-engine';

/** GET /api/business/invoices/[guid]/dunning-optout — { optedOut } */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const bookGuid = await getActiveBookGuid();
    if (!(await isInvoiceInBook(guid, bookGuid))) {
      throw new InvoiceNotFoundError(`Invoice not found: ${guid}`);
    }
    return NextResponse.json({ optedOut: await isDunningOptedOut(guid) });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/**
 * PUT /api/business/invoices/[guid]/dunning-optout — set the toggle.
 * Body: { optedOut: boolean }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body.optedOut !== 'boolean') {
      return NextResponse.json({ error: 'optedOut boolean is required' }, { status: 400 });
    }

    const bookGuid = await getActiveBookGuid();
    if (!(await isInvoiceInBook(guid, bookGuid))) {
      throw new InvoiceNotFoundError(`Invoice not found: ${guid}`);
    }
    await setDunningOptOut(bookGuid, guid, body.optedOut);
    return NextResponse.json({ optedOut: body.optedOut });
  } catch (error) {
    return mapInvoiceError(error);
  }
}
