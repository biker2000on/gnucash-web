import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { isAccountInActiveBook } from '@/lib/book-scope';

const VALID_COST_BASIS_METHODS = ['fifo', 'lifo', 'average'];
const VALID_LOT_ASSIGNMENT_METHODS = ['fifo', 'lifo', 'average'];
const VALID_RETIREMENT_TYPES = ['401k', '403b', '457', 'traditional_ira', 'roth_ira', 'hsa', 'brokerage'];

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

    const rows = await prisma.$queryRaw<{ account_guid: string; cost_basis_method: string | null; lot_assignment_method: string | null; is_retirement: boolean; retirement_account_type: string | null }[]>`
      SELECT account_guid, cost_basis_method, lot_assignment_method, is_retirement, retirement_account_type
      FROM gnucash_web_account_preferences
      WHERE account_guid = ${guid}
    `;

    if (rows.length === 0) {
      return NextResponse.json({ account_guid: guid, cost_basis_method: null, lot_assignment_method: null, is_retirement: false, retirement_account_type: null });
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

    // Validate cost_basis_method if present in request body
    if ('cost_basis_method' in body) {
      const { cost_basis_method } = body;
      if (cost_basis_method !== null && cost_basis_method !== undefined &&
          !VALID_COST_BASIS_METHODS.includes(cost_basis_method)) {
        return NextResponse.json(
          { error: `Invalid cost_basis_method. Must be one of: ${VALID_COST_BASIS_METHODS.join(', ')}` },
          { status: 400 }
        );
      }
    }

    // Validate lot_assignment_method if present in request body
    if ('lot_assignment_method' in body) {
      const { lot_assignment_method } = body;
      if (lot_assignment_method !== null && lot_assignment_method !== undefined &&
          !VALID_LOT_ASSIGNMENT_METHODS.includes(lot_assignment_method)) {
        return NextResponse.json(
          { error: `Invalid lot_assignment_method. Must be one of: ${VALID_LOT_ASSIGNMENT_METHODS.join(', ')}` },
          { status: 400 }
        );
      }
    }

    // Validate retirement_account_type if present in request body
    if ('retirement_account_type' in body) {
      const { retirement_account_type } = body;
      if (retirement_account_type !== null && retirement_account_type !== undefined &&
          !VALID_RETIREMENT_TYPES.includes(retirement_account_type)) {
        return NextResponse.json(
          { error: `Invalid retirement_account_type. Must be one of: ${VALID_RETIREMENT_TYPES.join(', ')}` },
          { status: 400 }
        );
      }
    }

    // Build the SET clause dynamically — only update fields present in the request body
    const hasCostBasis = 'cost_basis_method' in body;
    const hasLotAssignment = 'lot_assignment_method' in body;
    const hasRetirement = 'is_retirement' in body || 'retirement_account_type' in body;

    if (!hasCostBasis && !hasLotAssignment && !hasRetirement) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const costBasisValue = hasCostBasis ? (body.cost_basis_method ?? null) : undefined;
    const lotAssignmentValue = hasLotAssignment ? (body.lot_assignment_method ?? null) : undefined;

    if (hasCostBasis && hasLotAssignment) {
      await prisma.$executeRaw`
        INSERT INTO gnucash_web_account_preferences (account_guid, cost_basis_method, lot_assignment_method)
        VALUES (${guid}, ${costBasisValue}, ${lotAssignmentValue})
        ON CONFLICT (account_guid)
        DO UPDATE SET
          cost_basis_method = ${costBasisValue},
          lot_assignment_method = ${lotAssignmentValue}
      `;
    } else if (hasCostBasis) {
      await prisma.$executeRaw`
        INSERT INTO gnucash_web_account_preferences (account_guid, cost_basis_method)
        VALUES (${guid}, ${costBasisValue})
        ON CONFLICT (account_guid)
        DO UPDATE SET cost_basis_method = ${costBasisValue}
      `;
    } else if (hasLotAssignment) {
      await prisma.$executeRaw`
        INSERT INTO gnucash_web_account_preferences (account_guid, lot_assignment_method)
        VALUES (${guid}, ${lotAssignmentValue})
        ON CONFLICT (account_guid)
        DO UPDATE SET lot_assignment_method = ${lotAssignmentValue}
      `;
    }

    if (hasRetirement) {
      const isRetirement = body.is_retirement ?? false;
      const retirementType = body.retirement_account_type ?? null;

      await prisma.$executeRaw`
        INSERT INTO gnucash_web_account_preferences (account_guid, is_retirement, retirement_account_type)
        VALUES (${guid}, ${isRetirement}, ${retirementType})
        ON CONFLICT (account_guid)
        DO UPDATE SET
          is_retirement = COALESCE(${body.is_retirement !== undefined ? isRetirement : null}, gnucash_web_account_preferences.is_retirement),
          retirement_account_type = COALESCE(${body.retirement_account_type !== undefined ? retirementType : null}, gnucash_web_account_preferences.retirement_account_type)
      `;
    }

    // Fetch and return the updated row
    const rows = await prisma.$queryRaw<{ account_guid: string; cost_basis_method: string | null; lot_assignment_method: string | null; is_retirement: boolean; retirement_account_type: string | null }[]>`
      SELECT account_guid, cost_basis_method, lot_assignment_method, is_retirement, retirement_account_type
      FROM gnucash_web_account_preferences
      WHERE account_guid = ${guid}
    `;

    return NextResponse.json(rows[0] ?? { account_guid: guid, cost_basis_method: null, lot_assignment_method: null, is_retirement: false, retirement_account_type: null });
  } catch (error) {
    console.error('Error updating account preferences:', error);
    return NextResponse.json({ error: 'Failed to update account preferences' }, { status: 500 });
  }
}
