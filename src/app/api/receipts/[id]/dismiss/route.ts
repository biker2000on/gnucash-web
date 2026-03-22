// src/app/api/receipts/[id]/dismiss/route.ts

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { dismissMatch } from '@/lib/receipts';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { id } = await params;
    const receiptId = parseInt(id, 10);
    if (isNaN(receiptId)) {
      return NextResponse.json({ error: 'Invalid receipt ID' }, { status: 400 });
    }

    const body = await request.json();
    const { transaction_guid } = body;
    if (!transaction_guid) {
      return NextResponse.json({ error: 'transaction_guid required' }, { status: 400 });
    }

    const updated = await dismissMatch(receiptId, bookGuid, transaction_guid);
    if (!updated) {
      return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Dismiss error:', error);
    return NextResponse.json({ error: 'Failed to dismiss match' }, { status: 500 });
  }
}
