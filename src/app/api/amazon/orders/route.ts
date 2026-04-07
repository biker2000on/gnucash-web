import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { AmazonImportService } from '@/lib/services/amazon-import.service';

export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { searchParams } = new URL(request.url);
    const matchStatus = searchParams.get('matchStatus') || undefined;
    const batchIdStr = searchParams.get('batchId');
    const batchId = batchIdStr ? parseInt(batchIdStr, 10) : undefined;

    const orders = await AmazonImportService.listOrders(bookGuid, {
      matchStatus,
      batchId,
    });

    return NextResponse.json(orders);
  } catch (error) {
    console.error('List orders error:', error);
    return NextResponse.json({ error: 'Failed to list orders' }, { status: 500 });
  }
}
