import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getReceiptById } from '@/lib/receipts';
import { getStorageBackend } from '@/lib/storage/storage-backend';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { id } = await params;
    const receiptId = parseInt(id, 10);
    if (isNaN(receiptId)) {
      return NextResponse.json({ error: 'Invalid receipt ID' }, { status: 400 });
    }

    const receipt = await getReceiptById(receiptId, bookGuid);
    if (!receipt || !receipt.thumbnail_key) {
      return NextResponse.json({ error: 'Thumbnail not found' }, { status: 404 });
    }

    const storage = getStorageBackend();
    const buffer = await storage.get(receipt.thumbnail_key);

    return new Response(buffer, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=604800',
      },
    });
  } catch (error) {
    console.error('Thumbnail serve error:', error);
    return NextResponse.json({ error: 'Failed to serve thumbnail' }, { status: 500 });
  }
}
