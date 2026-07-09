import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookRootGuid } from '@/lib/book-scope';
import { postInvoice, unpostInvoice } from '@/lib/business/invoice-engine';
import { mapInvoiceError } from '@/lib/business/api-errors';

/**
 * POST /api/business/invoices/[guid]/post — post the invoice to A/R–A/P.
 * Body: { postDate: 'YYYY-MM-DD', dueDate?, memo?, description? }
 * Response: { result: { transactionGuid, lotGuid, postAccountGuid, total, dueDate } }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const body = await request.json();
    if (!body.postDate) {
      return NextResponse.json({ error: 'postDate is required' }, { status: 400 });
    }

    const bookRootGuid = await getActiveBookRootGuid();
    const result = await postInvoice(guid, {
      postDate: body.postDate,
      dueDate: body.dueDate,
      memo: body.memo,
      description: body.description,
      bookRootGuid,
    });
    return NextResponse.json({ result });
  } catch (error) {
    return mapInvoiceError(error);
  }
}

/**
 * DELETE /api/business/invoices/[guid]/post — unpost the invoice.
 * Rejects (409) when payments are attached to the invoice's lot.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    await unpostInvoice(guid);
    return NextResponse.json({ success: true });
  } catch (error) {
    return mapInvoiceError(error);
  }
}
