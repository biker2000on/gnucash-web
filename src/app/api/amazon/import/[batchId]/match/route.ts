import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { AmazonImportService } from '@/lib/services/amazon-import.service';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> },
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { batchId: batchIdStr } = await params;
    const batchId = parseInt(batchIdStr, 10);
    if (isNaN(batchId)) {
      return NextResponse.json({ error: 'Invalid batchId' }, { status: 400 });
    }

    const body = await request.json();
    const { orderId, transactionGuid, items } = body as {
      orderId: string;
      transactionGuid: string;
      items: Array<{ itemName: string; accountGuid: string }>;
    };

    if (!orderId || !transactionGuid || !items) {
      return NextResponse.json(
        { error: 'orderId, transactionGuid, and items are required' },
        { status: 400 },
      );
    }

    await AmazonImportService.confirmMatch(
      batchId,
      bookGuid,
      orderId,
      transactionGuid,
      items,
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Confirm match error:', error);
    const message = error instanceof Error ? error.message : 'Failed to confirm match';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
