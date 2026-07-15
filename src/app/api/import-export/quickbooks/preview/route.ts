import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { previewQboImport } from '@/lib/import/qbo-import.service';
import { readQboUpload } from '../shared';

/**
 * POST /api/import-export/quickbooks/preview
 *
 * Multipart form data:
 *   journal        — required QBO Journal report CSV file
 *   coa            — optional QBO Chart of Accounts CSV file
 *   bookName       — proposed book name (for duplicate warning)
 *   typeOverrides  — JSON { [accountPath]: gnucashType }
 *
 * Returns the parsed preview (no writes). Requires the edit role.
 */
export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const upload = await readQboUpload(request);
        if (upload instanceof NextResponse) return upload;

        const preview = await previewQboImport({
            journalContent: upload.journalContent,
            coaContent: upload.coaContent,
            bookName: upload.bookName,
            typeOverrides: upload.typeOverrides,
        });

        return NextResponse.json(preview);
    } catch (error) {
        console.error('QuickBooks preview failed:', error);
        return NextResponse.json({ error: 'QuickBooks preview failed' }, { status: 500 });
    }
}
