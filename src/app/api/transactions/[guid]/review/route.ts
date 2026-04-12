import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';

// PATCH /api/transactions/{guid}/review -- toggle reviewed status
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;

    // Upsert: if no meta row exists, create one as reviewed=true (toggle from default)
    const existing = await prisma.gnucash_web_transaction_meta.findUnique({
      where: { transaction_guid: guid },
      select: { reviewed: true },
    });

    if (existing) {
      const updated = await prisma.gnucash_web_transaction_meta.update({
        where: { transaction_guid: guid },
        data: { reviewed: !existing.reviewed },
        select: { reviewed: true },
      });
      return NextResponse.json({ reviewed: updated.reviewed });
    } else {
      // No meta row -- create one as reviewed (since manual transactions default to reviewed)
      await prisma.gnucash_web_transaction_meta.create({
        data: { transaction_guid: guid, source: 'manual', reviewed: true },
      });
      return NextResponse.json({ reviewed: true });
    }
  } catch (error) {
    console.error('Error toggling reviewed status:', error);
    return NextResponse.json({ error: 'Failed to toggle reviewed status' }, { status: 500 });
  }
}
