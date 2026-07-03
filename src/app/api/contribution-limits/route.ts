import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getAllLimitsForYear, RETIREMENT_ACCOUNT_TYPES } from '@/lib/reports/irs-limits';

const VALID_ACCOUNT_TYPES: string[] = [...RETIREMENT_ACCOUNT_TYPES, 'brokerage'];

export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const year = parseInt(searchParams.get('year') || new Date().getFullYear().toString());

    if (isNaN(year)) {
      return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
    }

    const limits = await getAllLimitsForYear(year);
    return NextResponse.json({ year, limits });
  } catch (error) {
    console.error('Error fetching contribution limits:', error);
    return NextResponse.json({ error: 'Failed to fetch contribution limits' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const { tax_year, account_type, base_limit, catch_up_limit, catch_up_age, notes } = body;

    if (!tax_year || !account_type || base_limit === undefined) {
      return NextResponse.json({ error: 'Missing required fields: tax_year, account_type, base_limit' }, { status: 400 });
    }

    if (typeof tax_year !== 'number' || tax_year < 2000 || tax_year > 2100) {
      return NextResponse.json({ error: 'tax_year must be a number between 2000 and 2100' }, { status: 400 });
    }
    if (!VALID_ACCOUNT_TYPES.includes(account_type)) {
      return NextResponse.json({ error: `Invalid account_type. Must be one of: ${VALID_ACCOUNT_TYPES.join(', ')}` }, { status: 400 });
    }
    if (typeof base_limit !== 'number' || base_limit < 0) {
      return NextResponse.json({ error: 'base_limit must be a non-negative number' }, { status: 400 });
    }
    if (catch_up_limit !== undefined && catch_up_limit !== null && (typeof catch_up_limit !== 'number' || catch_up_limit < 0)) {
      return NextResponse.json({ error: 'catch_up_limit must be a non-negative number' }, { status: 400 });
    }
    if (catch_up_age !== undefined && catch_up_age !== null && (typeof catch_up_age !== 'number' || catch_up_age < 0 || catch_up_age > 120)) {
      return NextResponse.json({ error: 'catch_up_age must be a number between 0 and 120' }, { status: 400 });
    }

    await prisma.$executeRaw`
      INSERT INTO gnucash_web_contribution_limits (tax_year, account_type, base_limit, catch_up_limit, catch_up_age, notes)
      VALUES (${tax_year}, ${account_type}, ${base_limit}, ${catch_up_limit ?? 0}, ${catch_up_age ?? 50}, ${notes ?? null})
      ON CONFLICT (tax_year, account_type)
      DO UPDATE SET
        base_limit = ${base_limit},
        catch_up_limit = ${catch_up_limit ?? 0},
        catch_up_age = ${catch_up_age ?? 50},
        notes = ${notes ?? null}
    `;

    const limits = await getAllLimitsForYear(tax_year);
    return NextResponse.json({ year: tax_year, limits });
  } catch (error) {
    console.error('Error updating contribution limit:', error);
    return NextResponse.json({ error: 'Failed to update contribution limit' }, { status: 500 });
  }
}

/** Remove a DB override so the code default (if any) applies again. */
export async function DELETE(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const year = parseInt(searchParams.get('year') || '');
    const accountType = searchParams.get('account_type') || '';

    if (isNaN(year) || year < 2000 || year > 2100) {
      return NextResponse.json({ error: 'year must be a number between 2000 and 2100' }, { status: 400 });
    }
    if (!VALID_ACCOUNT_TYPES.includes(accountType)) {
      return NextResponse.json({ error: `Invalid account_type. Must be one of: ${VALID_ACCOUNT_TYPES.join(', ')}` }, { status: 400 });
    }

    await prisma.gnucash_web_contribution_limits.deleteMany({
      where: { tax_year: year, account_type: accountType },
    });

    const limits = await getAllLimitsForYear(year);
    return NextResponse.json({ year, limits });
  } catch (error) {
    console.error('Error deleting contribution limit override:', error);
    return NextResponse.json({ error: 'Failed to delete contribution limit override' }, { status: 500 });
  }
}
