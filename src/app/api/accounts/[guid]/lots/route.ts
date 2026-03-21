import { NextResponse } from 'next/server';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';
import { getAccountLots, getFreeSplits } from '@/lib/lots';
import prisma from '@/lib/prisma';
import { generateGuid } from '@/lib/gnucash';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid: accountGuid } = await params;

        // Verify account belongs to active book
        if (!await isAccountInActiveBook(accountGuid)) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        const { searchParams } = new URL(request.url);
        const includeFreeSplits = searchParams.get('includeFreeSplits') === 'true';

        const lots = await getAccountLots(accountGuid);

        const response: { lots: typeof lots; freeSplits?: Awaited<ReturnType<typeof getFreeSplits>> } = { lots };

        if (includeFreeSplits) {
            response.freeSplits = await getFreeSplits(accountGuid);
        }

        return NextResponse.json(response);
    } catch (error) {
        console.error('Error fetching account lots:', error);
        return NextResponse.json({ error: 'Failed to fetch lots' }, { status: 500 });
    }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid: accountGuid } = await params;

    if (!await isAccountInActiveBook(accountGuid)) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const body = await request.json();
    const { title } = body;

    const lotGuid = generateGuid();

    await prisma.$transaction(async (tx) => {
      await tx.lots.create({
        data: {
          guid: lotGuid,
          account_guid: accountGuid,
          is_closed: 0,
        },
      });
      if (title) {
        await tx.slots.create({
          data: {
            obj_guid: lotGuid,
            name: 'title',
            slot_type: 4,
            string_val: title,
          },
        });
      }
    });

    return NextResponse.json({ guid: lotGuid, title: title || null }, { status: 201 });
  } catch (error) {
    console.error('Error creating lot:', error);
    return NextResponse.json({ error: 'Failed to create lot' }, { status: 500 });
  }
}
