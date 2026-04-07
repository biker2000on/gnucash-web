import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { AmazonImportService } from '@/lib/services/amazon-import.service';

export async function GET(
  _request: NextRequest,
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

    const result = await AmazonImportService.getBatch(batchId, bookGuid);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Get batch error:', error);
    const message = error instanceof Error ? error.message : 'Failed to get batch';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(
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

    const settings = await request.json();
    await AmazonImportService.updateBatchSettings(batchId, bookGuid, settings);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Update batch settings error:', error);
    const message = error instanceof Error ? error.message : 'Failed to update settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
