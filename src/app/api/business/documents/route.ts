import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    listEntityDocuments,
    createEntityDocument,
    EntityDocumentValidationError,
    EXPIRY_WARNING_DAYS,
} from '@/lib/services/entity-documents.service';

/**
 * GET /api/business/documents — the book's document vault. `expiringSoon`
 * is computed here (expired or expiring within 60 days) so the page can
 * surface reminders without a worker job; see the follow-up note about
 * worker-driven notifications in the vault page.
 */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const documents = await listEntityDocuments(bookGuid);
        const expiringSoon = documents.filter(
            (d) => d.daysUntilExpiry !== null && d.daysUntilExpiry <= EXPIRY_WARNING_DAYS
        );

        return NextResponse.json({ documents, expiringSoon, warningDays: EXPIRY_WARNING_DAYS });
    } catch (error) {
        console.error('Error listing entity documents:', error);
        return NextResponse.json({ error: 'Failed to list documents' }, { status: 500 });
    }
}

/** POST /api/business/documents — multipart upload (same limits as receipts). */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const formData = await request.formData();
        const file = formData.get('file');
        if (!(file instanceof File)) {
            return NextResponse.json({ error: 'No file provided' }, { status: 400 });
        }

        const title = (formData.get('title') as string | null)?.trim() || file.name;
        const docType = (formData.get('doc_type') as string | null) ?? 'other';
        const expiresOn = (formData.get('expires_on') as string | null) || null;
        const issuedOn = (formData.get('issued_on') as string | null) || null;
        const returnCopyDueOn = (formData.get('return_copy_due_on') as string | null) || null;
        const notes = (formData.get('notes') as string | null) || null;

        const buffer = Buffer.from(await file.arrayBuffer());
        const document = await createEntityDocument(bookGuid, {
            title,
            docType,
            expiresOn,
            issuedOn,
            returnCopyDueOn,
            notes,
            file: { buffer, filename: file.name },
        });

        return NextResponse.json({ document }, { status: 201 });
    } catch (error) {
        if (error instanceof EntityDocumentValidationError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        console.error('Error uploading entity document:', error);
        return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
    }
}
