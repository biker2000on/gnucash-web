import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getStorageBackend } from '@/lib/storage/storage-backend';
import { getBatch, listLines, deleteBatch } from '@/lib/services/statement.service';

type RouteParams = { params: Promise<{ id: string }> };

/** GET /api/statements/[id] — batch + its parsed lines. `?view=file` serves the original. */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { id } = await params;
    const batchId = parseInt(id, 10);
    if (isNaN(batchId)) {
      return NextResponse.json({ error: 'Invalid statement ID' }, { status: 400 });
    }

    const bookAccountGuids = await getBookAccountGuids();
    const batch = await getBatch(batchId, bookAccountGuids);
    if (!batch || batch.bookGuid !== bookGuid) {
      return NextResponse.json({ error: 'Statement not found' }, { status: 404 });
    }

    // Serve the original file if ?view=file
    const url = new URL(request.url);
    if (url.searchParams.get('view') === 'file' && batch.storageKey) {
      const storage = await getStorageBackend();
      const buffer = await storage.get(batch.storageKey);
      const contentType =
        batch.source === 'pdf'
          ? 'application/pdf'
          : batch.source === 'ofx'
            ? 'application/x-ofx'
            : 'text/csv';
      return new Response(new Uint8Array(buffer), {
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `inline; filename="statement-${batchId}"`,
          'Cache-Control': 'private, max-age=86400',
        },
      });
    }

    const lines = await listLines(batchId);
    return NextResponse.json({ batch, lines });
  } catch (error) {
    console.error('Statement fetch error:', error);
    return NextResponse.json({ error: 'Failed to fetch statement' }, { status: 500 });
  }
}

/** DELETE /api/statements/[id] — remove the batch, its lines, and stored files. */
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { id } = await params;
    const batchId = parseInt(id, 10);
    if (isNaN(batchId)) {
      return NextResponse.json({ error: 'Invalid statement ID' }, { status: 400 });
    }

    const bookAccountGuids = await getBookAccountGuids();
    const batch = await getBatch(batchId, bookAccountGuids);
    if (!batch || batch.bookGuid !== bookGuid) {
      return NextResponse.json({ error: 'Statement not found' }, { status: 404 });
    }

    const storage = await getStorageBackend();
    if (batch.storageKey) {
      try { await storage.delete(batch.storageKey); } catch (err) {
        console.warn('Failed to delete statement file:', err);
      }
    }
    if (batch.thumbnailKey) {
      try { await storage.delete(batch.thumbnailKey); } catch (err) {
        console.warn('Failed to delete statement thumbnail:', err);
      }
    }

    await deleteBatch(batchId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Statement delete error:', error);
    return NextResponse.json({ error: 'Failed to delete statement' }, { status: 500 });
  }
}
