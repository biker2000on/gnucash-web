import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { intakePayslip } from '@/lib/services/document-intake';

export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const formData = await request.formData();
    const files = formData.getAll('files') as File[];

    if (!files.length) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    const results: { id: number; filename: string; status: string }[] = [];

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());

      const result = await intakePayslip({
        bookGuid,
        userId: user.id,
        filename: file.name,
        buffer,
      });

      if (result.ok) {
        results.push({ id: result.id, filename: result.filename, status: 'uploaded' });
      } else {
        results.push({ id: 0, filename: result.filename, status: `error: ${result.error}` });
      }
    }

    return NextResponse.json({ results }, { status: 201 });
  } catch (error) {
    console.error('Payslip upload error:', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
