import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { intakeStatement } from '@/lib/services/document-intake';

/**
 * POST /api/statements/upload — multipart upload of a single statement file.
 * Fields: `file` (required), `accountGuid` (optional).
 * Detects pdf|csv|ofx, stores the original (+ thumbnail for pdf), creates a
 * batch (status 'uploaded'), and enqueues extraction (inline fallback if no
 * queue). Returns the created batch. Storage/extraction lives in the shared
 * intake core (src/lib/services/document-intake.ts).
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ error: 'No file provided (field "file")' }, { status: 400 });
    }

    const accountGuidRaw = formData.get('accountGuid');
    let accountGuid: string | null = null;
    if (typeof accountGuidRaw === 'string' && accountGuidRaw.trim()) {
      accountGuid = accountGuidRaw.trim();
      const bookGuids = await getBookAccountGuids();
      if (!bookGuids.includes(accountGuid)) {
        return NextResponse.json({ error: 'accountGuid is not in the active book' }, { status: 400 });
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const result = await intakeStatement({
      bookGuid,
      userId: user.id,
      filename: file.name,
      buffer,
      accountGuid,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({ batch: result.batch }, { status: 201 });
  } catch (error) {
    console.error('Statement upload error:', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
