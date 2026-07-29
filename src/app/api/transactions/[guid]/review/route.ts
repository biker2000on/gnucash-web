import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { publishDataChange } from '@/lib/data-events';

// PATCH /api/transactions/{guid}/review -- toggle reviewed status
//
// NOTE: this route only writes gnucash_web_transaction_meta (app extension
// data), never the core transaction or its splits, so it intentionally does
// NOT bump transactions.enter_date (the optimistic-concurrency token).
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    // "Reviewed" is an app-level bookkeeping annotation stored in
    // gnucash_web_transaction_meta, not GnuCash financial data, so any user
    // with book access (including readonly) may toggle it from the register.
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;

    // Upsert: if no meta row exists, create one as reviewed=true (toggle from default)
    const existing = await prisma.gnucash_web_transaction_meta.findUnique({
      where: { transaction_guid: guid },
      select: { reviewed: true },
    });

    let reviewed: boolean;
    if (existing) {
      const updated = await prisma.gnucash_web_transaction_meta.update({
        where: { transaction_guid: guid },
        data: { reviewed: !existing.reviewed },
        select: { reviewed: true },
      });
      reviewed = updated.reviewed;
    } else {
      // No meta row -- create one as reviewed (since manual transactions default to reviewed)
      await prisma.gnucash_web_transaction_meta.create({
        data: { transaction_guid: guid, source: 'manual', reviewed: true },
      });
      reviewed = true;
    }
    // Event only (no cache invalidation): review state feeds the to-review
    // badges and journal display other users have open, not the dashboards.
    void publishDataChange(roleResult.bookGuid, 'transactions', { guid, action: 'update' });
    return NextResponse.json({ reviewed });
  } catch (error) {
    console.error('Error toggling reviewed status:', error);
    return NextResponse.json({ error: 'Failed to toggle reviewed status' }, { status: 500 });
  }
}
