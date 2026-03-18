import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { isAccountInActiveBook } from '@/lib/book-scope';

const VALID_COST_BASIS_METHODS = ['fifo', 'lifo', 'average'];

// GET /api/accounts/{guid}/preferences
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;

    if (!await isAccountInActiveBook(guid)) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const rows = await prisma.$queryRaw<{ account_guid: string; cost_basis_method: string | null }[]>`
      SELECT account_guid, cost_basis_method
      FROM gnucash_web_account_preferences
      WHERE account_guid = ${guid}
    `;

    if (rows.length === 0) {
      return NextResponse.json({ account_guid: guid, cost_basis_method: null });
    }

    return NextResponse.json(rows[0]);
  } catch (error) {
    console.error('Error fetching account preferences:', error);
    return NextResponse.json({ error: 'Failed to fetch account preferences' }, { status: 500 });
  }
}

// PATCH /api/accounts/{guid}/preferences
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;

    if (!await isAccountInActiveBook(guid)) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const body = await request.json();
    const { cost_basis_method } = body;

    if (cost_basis_method !== null && cost_basis_method !== undefined &&
        !VALID_COST_BASIS_METHODS.includes(cost_basis_method)) {
      return NextResponse.json(
        { error: `Invalid cost_basis_method. Must be one of: ${VALID_COST_BASIS_METHODS.join(', ')}` },
        { status: 400 }
      );
    }

    await prisma.$executeRaw`
      INSERT INTO gnucash_web_account_preferences (account_guid, cost_basis_method)
      VALUES (${guid}, ${cost_basis_method ?? null})
      ON CONFLICT (account_guid)
      DO UPDATE SET cost_basis_method = ${cost_basis_method ?? null}
    `;

    return NextResponse.json({ account_guid: guid, cost_basis_method: cost_basis_method ?? null });
  } catch (error) {
    console.error('Error updating account preferences:', error);
    return NextResponse.json({ error: 'Failed to update account preferences' }, { status: 500 });
  }
}
