import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { generateGuid } from '@/lib/gnucash';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid: splitGuid } = await params;
    const body = await request.json();
    const { lot_guid, title } = body;

    // Verify split exists
    const split = await prisma.splits.findUnique({
      where: { guid: splitGuid },
      select: { guid: true, account_guid: true, lot_guid: true },
    });
    if (!split) {
      return NextResponse.json({ error: 'Split not found' }, { status: 404 });
    }

    // Verify split's account belongs to active book (security check)
    if (!await isAccountInActiveBook(split.account_guid)) {
      return NextResponse.json({ error: 'Split not found' }, { status: 404 });
    }

    let targetLotGuid: string | null = null;

    if (lot_guid === null) {
      // Unassign
      targetLotGuid = null;
    } else if (lot_guid === 'new') {
      // Create new lot
      const newGuid = generateGuid();
      await prisma.$transaction(async (tx) => {
        await tx.lots.create({
          data: {
            guid: newGuid,
            account_guid: split.account_guid,
            is_closed: 0,
          },
        });
        if (title) {
          await tx.slots.create({
            data: {
              obj_guid: newGuid,
              name: 'title',
              slot_type: 4,
              string_val: title,
            },
          });
        }
      });
      targetLotGuid = newGuid;
    } else {
      // Assign to existing lot — validate lot belongs to same account
      const lot = await prisma.lots.findUnique({
        where: { guid: lot_guid },
        select: { guid: true, account_guid: true },
      });
      if (!lot) {
        return NextResponse.json({ error: 'Lot not found' }, { status: 404 });
      }
      if (lot.account_guid !== split.account_guid) {
        return NextResponse.json(
          { error: 'Split and lot must belong to the same account' },
          { status: 400 }
        );
      }
      targetLotGuid = lot_guid;
    }

    // Update split
    await prisma.splits.update({
      where: { guid: splitGuid },
      data: { lot_guid: targetLotGuid },
    });

    return NextResponse.json({
      split_guid: splitGuid,
      lot_guid: targetLotGuid,
    });
  } catch (error) {
    console.error('Error assigning split to lot:', error);
    return NextResponse.json(
      { error: 'Failed to assign split to lot' },
      { status: 500 }
    );
  }
}
