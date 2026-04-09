import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { updateMapping, deleteMapping } from '@/lib/category-mapper';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: idStr } = await params;
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const body = await request.json();
    const { accountGuid } = body as { accountGuid: string };

    if (!accountGuid) {
      return NextResponse.json({ error: 'accountGuid is required' }, { status: 400 });
    }

    await updateMapping(id, accountGuid);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Update category mapping error:', error);
    return NextResponse.json({ error: 'Failed to update mapping' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: idStr } = await params;
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    await deleteMapping(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete category mapping error:', error);
    return NextResponse.json({ error: 'Failed to delete mapping' }, { status: 500 });
  }
}
