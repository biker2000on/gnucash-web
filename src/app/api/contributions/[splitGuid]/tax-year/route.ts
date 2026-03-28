import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ splitGuid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { splitGuid } = await params;
    const body = await request.json();
    const { taxYear } = body;

    if (!taxYear || typeof taxYear !== 'number') {
      return NextResponse.json({ error: 'Invalid taxYear' }, { status: 400 });
    }

    const split = await prisma.splits.findUnique({ where: { guid: splitGuid } });
    if (!split) {
      return NextResponse.json({ error: 'Split not found' }, { status: 404 });
    }

    await prisma.$executeRaw`
      INSERT INTO gnucash_web_contribution_tax_year (split_guid, tax_year)
      VALUES (${splitGuid}, ${taxYear})
      ON CONFLICT (split_guid)
      DO UPDATE SET tax_year = ${taxYear}
    `;

    return NextResponse.json({ splitGuid, taxYear });
  } catch (error) {
    console.error('Error updating tax year override:', error);
    return NextResponse.json({ error: 'Failed to update tax year' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ splitGuid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { splitGuid } = await params;

    await prisma.$executeRaw`
      DELETE FROM gnucash_web_contribution_tax_year WHERE split_guid = ${splitGuid}
    `;

    return NextResponse.json({ splitGuid, taxYear: null });
  } catch (error) {
    console.error('Error removing tax year override:', error);
    return NextResponse.json({ error: 'Failed to remove tax year override' }, { status: 500 });
  }
}
