import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookRootGuid } from '@/lib/book-scope';
import { postVoucher, unpostVoucher } from '@/lib/business/vouchers';
import { mapInvoiceError } from '@/lib/business/api-errors';

/**
 * POST /api/business/vouchers/[guid]/post — post the voucher to A/P
 * (credit Accounts Payable, debit the expense accounts).
 * Body: { postDate: 'YYYY-MM-DD', dueDate?, memo?, description? }
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
    const result = await postVoucher(guid, {
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
 * DELETE /api/business/vouchers/[guid]/post — unpost the voucher.
 * Rejects (409) when reimbursements are attached to the voucher's lot.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    await unpostVoucher(guid);
    return NextResponse.json({ success: true });
  } catch (error) {
    return mapInvoiceError(error);
  }
}
