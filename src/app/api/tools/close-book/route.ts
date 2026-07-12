import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { previewCloseBook, executeCloseBook } from '@/lib/close-book';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/tools/close-book?date=YYYY-MM-DD — preview closing entries. */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const date = request.nextUrl.searchParams.get('date') ?? '';
    if (!DATE_RE.test(date)) {
      return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    }

    const bookAccountGuids = await getBookAccountGuids();
    const preview = await previewCloseBook(bookAccountGuids, date);
    return NextResponse.json(preview);
  } catch (error) {
    console.error('Error previewing close book:', error);
    return NextResponse.json({ error: 'Failed to preview closing entries' }, { status: 500 });
  }
}

/** POST /api/tools/close-book { date, equityAccountGuid, description? } — post closing entries. */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const { date, equityAccountGuid, description } = body as {
      date?: string;
      equityAccountGuid?: string;
      description?: string;
    };
    if (!date || !DATE_RE.test(date)) {
      return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    }
    if (!equityAccountGuid || equityAccountGuid.length !== 32) {
      return NextResponse.json({ error: 'equityAccountGuid is required' }, { status: 400 });
    }

    const bookAccountGuids = await getBookAccountGuids();
    const result = await executeCloseBook(
      bookAccountGuids,
      date,
      equityAccountGuid,
      typeof description === 'string' ? description.slice(0, 200) : '',
    );
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error executing close book:', error);
    const message = error instanceof Error ? error.message : 'Failed to post closing entries';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
