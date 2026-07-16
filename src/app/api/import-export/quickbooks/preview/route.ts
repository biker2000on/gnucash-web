import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { previewQboImport } from '@/lib/import/qbo-import.service';
import { readQboUpload } from '../shared';

/**
 * POST /api/import-export/quickbooks/preview
 *
 * Multipart form data (one of archive/journal is required):
 *   archive        — QBO "Export data" ZIP or a single XLSX workbook
 *   journal        — QBO Journal report CSV file (legacy path; .zip/.xlsx
 *                    dropped here is treated as an archive)
 *   coa            — optional QBO Chart of Accounts CSV or XLSX file
 *   bookName       — proposed book name (for duplicate warning)
 *   typeOverrides  — JSON { [accountPath]: gnucashType }
 *
 * Returns the parsed preview (no writes), including sourceFormat
 * ('journal' | 'general_ledger'), GL reconstruction stats, and the sheets
 * found in the archive. Requires the edit role.
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
            archive: upload.archive,
            coaArchive: upload.coaArchive,
            bookName: upload.bookName,
            typeOverrides: upload.typeOverrides,
            locale: upload.locale,
        });

        return NextResponse.json(preview);
    } catch (error) {
        console.error('QuickBooks preview failed:', error);
        return NextResponse.json({ error: 'QuickBooks preview failed' }, { status: 500 });
    }
}
