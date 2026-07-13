import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { intakeReceipt } from '@/lib/services/document-intake';

export async function POST(request: Request) {
  try {
    // Receipts are app-managed data (not GnuCash data), so all authenticated users can upload
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const formData = await request.formData();
    const transactionGuid = formData.get('transaction_guid') as string | null;
    const files = formData.getAll('files') as File[];

    if (!files.length) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    if (transactionGuid) {
      const { query: dbQuery } = await import('@/lib/db');
      const txResult = await dbQuery(
        'SELECT guid FROM transactions WHERE guid = $1',
        [transactionGuid]
      );
      if (txResult.rows.length === 0) {
        return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
      }
    }

    const results: { id: number; filename: string; status: string }[] = [];

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());

      const result = await intakeReceipt({
        bookGuid,
        userId: user.id,
        filename: file.name,
        buffer,
        transactionGuid,
      });

      if (result.ok) {
        results.push({ id: result.id, filename: result.filename, status: 'uploaded' });
      } else {
        results.push({ id: 0, filename: result.filename, status: `error: ${result.error}` });
      }
    }

    return NextResponse.json({ results }, { status: 201 });
  } catch (error) {
    console.error('Receipt upload error:', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
