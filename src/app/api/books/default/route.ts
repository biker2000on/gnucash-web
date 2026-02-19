import { NextRequest, NextResponse } from 'next/server';
import { createDefaultBook } from '@/lib/default-book';
import { requireAuth } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth();
    if (authResult instanceof NextResponse) return authResult;

    const body = await request.json().catch(() => ({}));
    const name = body.name || 'My Finances';
    const description = body.description;

    const bookGuid = await createDefaultBook(name, description);

    return NextResponse.json({ success: true, bookGuid });
  } catch (error) {
    console.error('Error creating default book:', error);
    const message = error instanceof Error ? error.message : 'Failed to create default book';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
