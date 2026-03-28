import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getAllLimitsForYear } from '@/lib/reports/irs-limits';

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

    const VALID_ACCOUNT_TYPES = ['401k', '403b', '457', 'traditional_ira', 'roth_ira', 'hsa', 'hra', 'fsa', 'brokerage'];
    if (typeof tax_year !== 'number' || tax_year < 2000 || tax_year > 2100) {
      return NextResponse.json({ error: 'tax_year must be a number between 2000 and 2100' }, { status: 400 });
    }
    if (!VALID_ACCOUNT_TYPES.includes(account_type)) {
      return NextResponse.json({ error: `Invalid account_type. Must be one of: ${VALID_ACCOUNT_TYPES.join(', ')}` }, { status: 400 });
    }
    if (typeof base_limit !== 'number' || base_limit < 0) {
      return NextResponse.json({ error: 'base_limit must be a non-negative number' }, { status: 400 });
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
