import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { commitQboImport } from '@/lib/import/qbo-import.service';
import { ENTITY_TYPES, type EntityType } from '@/lib/services/entity.service';
import { readQboUpload } from '../shared';

/**
 * POST /api/import-export/quickbooks/commit
 *
 * Stateless commit: the client re-sends the same files as preview plus the
 * chosen options, and the server re-parses and imports them into a NEW book.
 *
 * Multipart form data (one of archive/journal is required):
 *   archive        — QBO "Export data" ZIP or a single XLSX workbook
 *   journal        — QBO Journal report CSV file (legacy path)
 *   coa            — optional QBO Chart of Accounts CSV or XLSX file
 *   bookName       — required name for the new book
 *   entityType     — one of ENTITY_TYPES (default c_corp)
 *   currency       — ISO 4217 (default USD)
 *   typeOverrides  — JSON { [accountPath]: gnucashType }
 *
 * Requires the edit role. Returns { bookGuid, accountsCreated,
 * transactionsCreated, splitsCreated, skippedErrors, warnings }.
 */
export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { user } = roleResult;

        const upload = await readQboUpload(request);
        if (upload instanceof NextResponse) return upload;

        if (!upload.bookName) {
            return NextResponse.json({ error: 'bookName is required' }, { status: 400 });
        }

        const entityType = (upload.entityType ?? 'c_corp') as EntityType;
        if (!ENTITY_TYPES.includes(entityType)) {
            return NextResponse.json(
                { error: `Invalid entity type: ${upload.entityType}` },
                { status: 400 }
            );
        }

        const result = await commitQboImport(user.id, {
            journalContent: upload.journalContent,
            coaContent: upload.coaContent,
            archive: upload.archive,
            coaArchive: upload.coaArchive,
            bookName: upload.bookName,
            currency: upload.currency ?? 'USD',
            entityType,
            typeOverrides: upload.typeOverrides,
            filename: upload.filename,
            locale: upload.locale,
        });

        return NextResponse.json({ success: true, ...result });
    } catch (error) {
        console.error('QuickBooks import failed:', error);
        const message = error instanceof Error ? error.message : 'QuickBooks import failed';
        // Parse/validation problems reported by the service are caller-fixable.
        const clientFacing =
            message.startsWith('No importable transactions') ||
            message.startsWith('Book name is required') ||
            message.startsWith('Could not find the Journal header') ||
            message.startsWith('Could not read');
        return NextResponse.json(
            { error: clientFacing ? message : 'QuickBooks import failed' },
            { status: clientFacing ? 400 : 500 }
        );
    }
}
