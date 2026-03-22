import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getReceiptById, deleteReceipt, linkReceipt } from '@/lib/receipts';
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
    if (!receipt) {
      return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
    }

    const storage = getStorageBackend();
    const buffer = await storage.get(receipt.storage_key);

    return new Response(buffer, {
      headers: {
        'Content-Type': receipt.mime_type,
        'Content-Disposition': `inline; filename="${receipt.filename}"`,
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch (error) {
    console.error('Receipt serve error:', error);
    return NextResponse.json({ error: 'Failed to serve receipt' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const { id } = await params;
    const receiptId = parseInt(id, 10);
    if (isNaN(receiptId)) {
      return NextResponse.json({ error: 'Invalid receipt ID' }, { status: 400 });
    }

    const receipt = await getReceiptById(receiptId, bookGuid);
    if (!receipt) {
      return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
    }

    if (receipt.created_by !== user.id) {
      const { getUserRoleForBook } = await import('@/lib/services/permission.service');
      const userRole = await getUserRoleForBook(user.id, bookGuid);
      if (userRole !== 'admin') {
        return NextResponse.json({ error: 'Only the uploader or an admin can delete' }, { status: 403 });
      }
    }

    const storage = getStorageBackend();
    try {
      await storage.delete(receipt.storage_key);
      if (receipt.thumbnail_key) {
        await storage.delete(receipt.thumbnail_key);
      }
    } catch (err) {
      console.warn('Failed to delete receipt files:', err);
    }

    await deleteReceipt(receiptId, bookGuid);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Receipt delete error:', error);
    return NextResponse.json({ error: 'Failed to delete receipt' }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
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

    if (transaction_guid !== null && transaction_guid !== undefined) {
      const { query: dbQuery } = await import('@/lib/db');
      const txResult = await dbQuery(
        'SELECT guid FROM transactions WHERE guid = $1',
        [transaction_guid]
      );
      if (txResult.rows.length === 0) {
        return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
      }
    }

    const updated = await linkReceipt(receiptId, bookGuid, transaction_guid ?? null);
    if (!updated) {
      return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Receipt link error:', error);
    return NextResponse.json({ error: 'Failed to update receipt' }, { status: 500 });
  }
}
