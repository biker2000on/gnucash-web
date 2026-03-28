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
