import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { resolveActiveShareTarget } from '@/lib/business/invoice-shares.service';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;
    const target = await resolveActiveShareTarget(token);
    if (!target || target.estimateId === null) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    }
    const body = await request.json().catch(() => null) as { decision?: unknown } | null;
    if (body?.decision !== 'accepted' && body?.decision !== 'declined') {
      return NextResponse.json({ error: 'Decision must be accepted or declined' }, { status: 400 });
    }
    const updated = await prisma.gnucash_web_estimates.updateMany({
      where: {
        id: target.estimateId,
        book_guid: target.bookGuid,
        status: { in: ['draft', 'sent'] },
      },
      data: { status: body.decision, updated_at: new Date() },
    });
    if (updated.count === 0) {
      return NextResponse.json({ error: 'This estimate can no longer be changed' }, { status: 409 });
    }
    return NextResponse.json({ success: true, status: body.decision });
  } catch (error) {
    console.error('Public estimate response error:', error);
    return NextResponse.json({ error: 'Unable to record response' }, { status: 500 });
  }
}
