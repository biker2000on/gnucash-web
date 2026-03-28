import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { batchExecuteSkip, BatchItem } from '@/lib/services/scheduled-tx-execute';

export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const { items } = body;

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items array is required and must not be empty' }, { status: 400 });
    }

    for (const item of items) {
      if (!item.guid || !item.occurrenceDate || !['execute', 'skip'].includes(item.action)) {
        return NextResponse.json({
          error: 'Each item must have guid, occurrenceDate (YYYY-MM-DD), and action (execute|skip)',
        }, { status: 400 });
      }
    }

    const result = await batchExecuteSkip(items as BatchItem[]);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error batch executing:', error);
    return NextResponse.json({ error: 'Failed to batch execute' }, { status: 500 });
  }
}
