import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';

const VALID_TRANSACTION_TYPES = [
  'buy', 'sell', 'dividend', 'stock_split',
  'return_of_capital', 'reinvested_dividend', 'other',
];

// GET /api/transactions/{guid}/type — get transaction type override for a split
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const { searchParams } = new URL(request.url);
    const splitGuid = searchParams.get('split_guid') || guid;

    const rows = await prisma.$queryRaw<{ split_guid: string; transaction_type: string }[]>`
      SELECT split_guid, transaction_type
      FROM gnucash_web_transaction_types
      WHERE split_guid = ${splitGuid}
    `;

    if (rows.length === 0) {
      return NextResponse.json({ split_guid: splitGuid, transaction_type: null });
    }

    return NextResponse.json(rows[0]);
  } catch (error) {
    console.error('Error fetching transaction type:', error);
    return NextResponse.json({ error: 'Failed to fetch transaction type' }, { status: 500 });
  }
}

// PUT /api/transactions/{guid}/type — set/update transaction type override
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    await params; // consume params

    const body = await request.json();
    const { split_guid, transaction_type } = body;

    if (!split_guid || typeof split_guid !== 'string') {
      return NextResponse.json({ error: 'split_guid is required' }, { status: 400 });
    }

    if (!transaction_type || !VALID_TRANSACTION_TYPES.includes(transaction_type)) {
      return NextResponse.json(
        { error: `Invalid transaction_type. Must be one of: ${VALID_TRANSACTION_TYPES.join(', ')}` },
        { status: 400 }
      );
    }

    await prisma.$executeRaw`
      INSERT INTO gnucash_web_transaction_types (split_guid, transaction_type)
      VALUES (${split_guid}, ${transaction_type})
      ON CONFLICT (split_guid)
      DO UPDATE SET transaction_type = ${transaction_type}
    `;

    return NextResponse.json({ split_guid, transaction_type });
  } catch (error) {
    console.error('Error setting transaction type:', error);
    return NextResponse.json({ error: 'Failed to set transaction type' }, { status: 500 });
  }
}

// DELETE /api/transactions/{guid}/type — remove transaction type override
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    await params; // consume params

    const { searchParams } = new URL(request.url);
    const splitGuid = searchParams.get('split_guid');

    if (!splitGuid) {
      return NextResponse.json({ error: 'split_guid query parameter is required' }, { status: 400 });
    }

    await prisma.$executeRaw`
      DELETE FROM gnucash_web_transaction_types
      WHERE split_guid = ${splitGuid}
    `;

    return NextResponse.json({ deleted: true, split_guid: splitGuid });
  } catch (error) {
    console.error('Error deleting transaction type:', error);
    return NextResponse.json({ error: 'Failed to delete transaction type' }, { status: 500 });
  }
}
