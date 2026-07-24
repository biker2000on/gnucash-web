import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  addJobCostLink,
  deleteJobCostLink,
} from '@/lib/business/jobs.service';
import { BusinessValidationError } from '@/lib/services/business.service';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> },
) {
  try {
    const auth = await requireRole('edit');
    if (auth instanceof NextResponse) return auth;
    const { guid } = await params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: 'Request body is required' }, { status: 400 });
    const sourceType = typeof body.sourceType === 'string' ? body.sourceType : 'manual';
    if (!['manual', 'transaction', 'voucher', 'material'].includes(sourceType)) {
      return NextResponse.json({ error: 'Invalid source type' }, { status: 400 });
    }
    const cost = await addJobCostLink({
      bookGuid: auth.bookGuid,
      jobGuid: guid,
      userId: auth.user.id,
      sourceType: sourceType as 'manual' | 'transaction' | 'voucher' | 'material',
      sourceId: typeof body.sourceId === 'string' ? body.sourceId.trim() || null : null,
      description: typeof body.description === 'string' ? body.description : undefined,
      costDate: typeof body.costDate === 'string' ? body.costDate : '',
      amount: Number(body.amount),
      billable: body.billable === true,
    });
    return NextResponse.json({ cost }, { status: 201 });
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error adding job cost:', error);
    return NextResponse.json({ error: 'Failed to add job cost' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> },
) {
  try {
    const auth = await requireRole('edit');
    if (auth instanceof NextResponse) return auth;
    const { guid } = await params;
    const id = Number(request.nextUrl.searchParams.get('id'));
    if (!Number.isInteger(id)) return NextResponse.json({ error: 'Valid cost id is required' }, { status: 400 });
    const deleted = await deleteJobCostLink(auth.bookGuid, guid, id, auth.user.id);
    return deleted
      ? NextResponse.json({ success: true })
      : NextResponse.json({ error: 'Cost link not found' }, { status: 404 });
  } catch (error) {
    console.error('Error deleting job cost:', error);
    return NextResponse.json({ error: 'Failed to delete job cost' }, { status: 500 });
  }
}
