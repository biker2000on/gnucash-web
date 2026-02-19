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
    const existing = await prisma.$queryRaw<{ reviewed: boolean }[]>`
      SELECT reviewed FROM gnucash_web_transaction_meta WHERE transaction_guid = ${guid}
    `;

    if (existing.length > 0) {
      await prisma.$executeRaw`
        UPDATE gnucash_web_transaction_meta
        SET reviewed = NOT reviewed
        WHERE transaction_guid = ${guid}
      `;
      return NextResponse.json({ reviewed: !existing[0].reviewed });
    } else {
      // No meta row -- create one as reviewed (since manual transactions default to reviewed)
      await prisma.$executeRaw`
        INSERT INTO gnucash_web_transaction_meta (transaction_guid, source, reviewed)
        VALUES (${guid}, 'manual', TRUE)
      `;
      return NextResponse.json({ reviewed: true });
    }
  } catch (error) {
    console.error('Error toggling reviewed status:', error);
    return NextResponse.json({ error: 'Failed to toggle reviewed status' }, { status: 500 });
  }
}
