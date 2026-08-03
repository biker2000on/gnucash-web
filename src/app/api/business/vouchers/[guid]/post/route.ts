import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { postVoucher, unpostVoucher } from '@/lib/business/vouchers';
import { mapInvoiceError } from '@/lib/business/api-errors';
import { markReimbursementVoucherPosted } from '@/lib/business/reimbursements';
import { cacheInvalidateAllForBook } from '@/lib/cache';
import { publishDataChange } from '@/lib/data-events';

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

    const result = await postVoucher(roleResult.bookGuid, guid, {
      postDate: body.postDate,
      dueDate: body.dueDate,
      memo: body.memo,
      description: body.description,
    });
    await markReimbursementVoucherPosted(guid, roleResult.bookGuid);
    void cacheInvalidateAllForBook(roleResult.bookGuid);
    void publishDataChange(roleResult.bookGuid, 'business', { guid, action: 'update' });
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
    await unpostVoucher(roleResult.bookGuid, guid);
    void cacheInvalidateAllForBook(roleResult.bookGuid);
    void publishDataChange(roleResult.bookGuid, 'business', { guid, action: 'update' });
    return NextResponse.json({ success: true });
  } catch (error) {
    return mapInvoiceError(error);
  }
}
