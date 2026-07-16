import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { listEmailBills, type EmailBillStatus } from '@/lib/business/bill-capture';

const VALID_STATUSES: EmailBillStatus[] = [
  'pending_extraction',
  'needs_review',
  'drafted',
  'dismissed',
  'error',
];

/**
 * GET /api/business/bill-drafts?status=needs_review,drafted
 *
 * Email-captured bill drafts for the active book. Without `status`, returns
 * everything except dismissed rows.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get('status');
    let statuses: EmailBillStatus[] | undefined;
    if (statusParam) {
      const requested = statusParam.split(',').map(s => s.trim()).filter(Boolean);
      const invalid = requested.filter(s => !VALID_STATUSES.includes(s as EmailBillStatus));
      if (invalid.length > 0) {
        return NextResponse.json({ error: `Invalid status: ${invalid.join(', ')}` }, { status: 400 });
      }
      statuses = requested as EmailBillStatus[];
    } else {
      statuses = VALID_STATUSES.filter(s => s !== 'dismissed');
    }

    const bookGuid = await getActiveBookGuid();
    const bills = await listEmailBills(bookGuid, statuses);
    return NextResponse.json({ bills });
  } catch (error) {
    console.error('Error listing email bill drafts:', error);
    return NextResponse.json({ error: 'Failed to list bill drafts' }, { status: 500 });
  }
}
