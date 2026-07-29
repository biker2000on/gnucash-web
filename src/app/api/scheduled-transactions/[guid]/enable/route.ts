import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { isScheduledTransactionInBook } from '@/lib/services/scheduled-tx-create';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    if (!await isScheduledTransactionInBook(guid, roleResult.bookGuid)) {
      return NextResponse.json({ error: 'Scheduled transaction not found' }, { status: 404 });
    }
    const body = await request.json();

    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }

    const enabledInt = body.enabled ? 1 : 0;

    const affected = await prisma.$executeRaw`
      UPDATE schedxactions SET enabled = ${enabledInt} WHERE guid = ${guid}
    `;

    if (affected === 0) {
      return NextResponse.json({ error: 'Scheduled transaction not found' }, { status: 404 });
    }

    return NextResponse.json({ guid, enabled: body.enabled });
  } catch (error) {
    console.error('Error toggling scheduled transaction:', error);
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
  }
}
