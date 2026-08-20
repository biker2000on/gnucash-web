import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    listEntityDocuments,
    createEntityDocument,
    EntityDocumentValidationError,
    EXPIRY_WARNING_DAYS,
} from '@/lib/services/entity-documents.service';
import { getTagsForDocuments } from '@/lib/documents/document-tags';
import { getDocumentThumbnailStatuses } from '@/lib/documents/thumbnail-store';
import { enqueueDocumentThumbnail } from '@/lib/queue/jobs/render-document-thumbnail';

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
        const ids = documents.map((d) => d.id);
        const [tagMap, thumbMap] = await Promise.all([
            getTagsForDocuments(bookGuid, ids),
            getDocumentThumbnailStatuses(bookGuid, ids),
        ]);
        const withSidecars = documents.map((d) => ({
            ...d,
            tags: tagMap.get(d.id) ?? [],
            thumbnailStatus: thumbMap.get(d.id) ?? null,
        }));
        const expiringSoon = withSidecars.filter(
            (d) => d.daysUntilExpiry !== null && d.daysUntilExpiry <= EXPIRY_WARNING_DAYS
        );

        return NextResponse.json({
            documents: withSidecars,
            expiringSoon,
            warningDays: EXPIRY_WARNING_DAYS,
        });
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
        const { bookGuid, user } = roleResult;

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
        const taxYearRaw = (formData.get('tax_year') as string | null) || null;
        const taxYearParsed = taxYearRaw === null ? null : parseInt(taxYearRaw, 10);
        const taxYear = taxYearParsed !== null && Number.isInteger(taxYearParsed) ? taxYearParsed : null;
        const taxForm = (formData.get('tax_form') as string | null) || null;
        const issuer = (formData.get('issuer') as string | null) || null;

        const buffer = Buffer.from(await file.arrayBuffer());
        const document = await createEntityDocument(bookGuid, {
            title,
            docType,
            expiresOn,
            issuedOn,
            returnCopyDueOn,
            notes,
            taxYear,
            taxForm,
            issuer,
            ownerUserId: user.id,
            file: { buffer, filename: file.name },
        });

        try {
            await enqueueDocumentThumbnail(document.id, bookGuid);
        } catch (thumbError) {
            console.warn('Failed to enqueue document thumbnail:', thumbError);
        }

        return NextResponse.json({ document }, { status: 201 });
    } catch (error) {
        if (error instanceof EntityDocumentValidationError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        console.error('Error uploading entity document:', error);
        return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
    }
}
