/**
 * Shared Next.js route handlers for the Wave / Xero new-book importers.
 *
 * Each source's preview/commit route is a one-liner:
 *
 *     export const POST = makeBusinessPreviewRoute('wave');
 *     export const POST = makeBusinessCommitRoute('wave');
 *
 * Both are stateless: the client re-sends the same files for commit plus the
 * chosen options, and the server re-parses them. A commit creates a brand-NEW
 * book (edit role required), grants the importer admin, and saves the entity
 * profile — mirroring the QuickBooks importer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { ENTITY_TYPES, type EntityType } from '@/lib/services/entity.service';
import type { ImportLocaleId } from './parse-locale';
import {
    previewBusinessImport,
    commitBusinessImport,
    BUSINESS_SOURCE_LABELS,
    type BusinessPreviewInput,
    type BusinessSource,
} from './business-import.service';

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB per CSV file
export const MAX_JOURNAL_LINES = 100_000;

const DEFAULT_ENTITY_TYPE: Record<BusinessSource, EntityType> = {
    wave: 'sole_prop',
    xero: 'c_corp',
};

interface BusinessUpload {
    journalContent: string | null;
    coaContent: string | null;
    bookName: string | null;
    typeOverrides: Record<string, string>;
    entityType: string | null;
    currency: string | null;
    filename: string | null;
    locale: ImportLocaleId;
}

function countLines(content: string): number {
    let count = 1;
    for (let i = 0; i < content.length; i++) {
        if (content[i] === '\n') count++;
    }
    return count;
}

function parseOverrides(raw: FormDataEntryValue | null): Record<string, string> {
    if (!raw || typeof raw !== 'string') return {};
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') out[k] = v;
        }
        return out;
    } catch {
        return {};
    }
}

async function readBusinessUpload(
    source: BusinessSource,
    request: NextRequest
): Promise<BusinessUpload | NextResponse> {
    const label = BUSINESS_SOURCE_LABELS[source];
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
        return NextResponse.json(
            { error: 'Expected multipart/form-data with a "journal" file' },
            { status: 400 }
        );
    }

    let formData: FormData;
    try {
        formData = await request.formData();
    } catch {
        return NextResponse.json({ error: 'Could not read the upload' }, { status: 400 });
    }

    let journalContent: string | null = null;
    let journalName: string | null = null;
    const journalFile = formData.get('journal');
    if (journalFile instanceof File && journalFile.size > 0) {
        if (journalFile.size > MAX_FILE_BYTES) {
            return NextResponse.json({ error: 'Transactions file too large (20 MB max)' }, { status: 413 });
        }
        journalContent = await journalFile.text();
        journalName = journalFile.name || null;
        if (!journalContent.trim()) {
            return NextResponse.json({ error: 'The transactions file is empty' }, { status: 400 });
        }
        if (countLines(journalContent) > MAX_JOURNAL_LINES) {
            return NextResponse.json(
                {
                    error: `Transactions file has too many rows (${MAX_JOURNAL_LINES.toLocaleString()} max). Split the export into smaller date ranges.`,
                },
                { status: 413 }
            );
        }
    }
    if (!journalContent) {
        return NextResponse.json(
            { error: `A ${label} transactions CSV export is required` },
            { status: 400 }
        );
    }

    let coaContent: string | null = null;
    const coaFile = formData.get('coa');
    if (coaFile instanceof File && coaFile.size > 0) {
        if (coaFile.size > MAX_FILE_BYTES) {
            return NextResponse.json({ error: 'Chart of Accounts file too large (20 MB max)' }, { status: 413 });
        }
        coaContent = await coaFile.text();
    }

    const str = (key: string): string | null => {
        const v = formData.get(key);
        return typeof v === 'string' && v.trim() ? v.trim() : null;
    };

    return {
        journalContent,
        coaContent,
        bookName: str('bookName'),
        typeOverrides: parseOverrides(formData.get('typeOverrides')),
        entityType: str('entityType'),
        currency: str('currency'),
        filename: journalName,
        locale: str('locale') === 'eu' ? 'eu' : 'us',
    };
}

function toPreviewInput(upload: BusinessUpload): BusinessPreviewInput {
    return {
        journalContent: upload.journalContent,
        coaContent: upload.coaContent,
        bookName: upload.bookName,
        typeOverrides: upload.typeOverrides,
        locale: upload.locale,
    };
}

/**
 * POST /api/import-export/{wave|xero}/preview
 *
 * Multipart form data:
 *   journal        — the transactions/journal report CSV (required)
 *   coa            — optional Chart of Accounts CSV
 *   bookName       — proposed book name (for the duplicate warning)
 *   typeOverrides  — JSON { [accountPath]: gnucashType }
 *   locale         — 'us' (default) | 'eu' (day-first dates, comma decimals)
 *
 * Returns the parsed preview (no writes). Requires the edit role.
 */
export function makeBusinessPreviewRoute(source: BusinessSource) {
    return async function POST(request: NextRequest) {
        try {
            const roleResult = await requireRole('edit');
            if (roleResult instanceof NextResponse) return roleResult;

            const upload = await readBusinessUpload(source, request);
            if (upload instanceof NextResponse) return upload;

            const preview = await previewBusinessImport(source, toPreviewInput(upload));
            return NextResponse.json(preview);
        } catch (error) {
            console.error(`${BUSINESS_SOURCE_LABELS[source]} preview failed:`, error);
            return NextResponse.json(
                { error: `${BUSINESS_SOURCE_LABELS[source]} preview failed` },
                { status: 500 }
            );
        }
    };
}

/**
 * POST /api/import-export/{wave|xero}/commit
 *
 * Same multipart fields as preview, plus:
 *   bookName       — required name for the new book
 *   entityType     — one of ENTITY_TYPES (default sole_prop for Wave,
 *                    c_corp for Xero)
 *   currency       — ISO 4217 (default USD)
 *
 * Creates a NEW book. Requires the edit role.
 */
export function makeBusinessCommitRoute(source: BusinessSource) {
    return async function POST(request: NextRequest) {
        const label = BUSINESS_SOURCE_LABELS[source];
        try {
            const roleResult = await requireRole('edit');
            if (roleResult instanceof NextResponse) return roleResult;
            const { user } = roleResult;

            const upload = await readBusinessUpload(source, request);
            if (upload instanceof NextResponse) return upload;

            if (!upload.bookName) {
                return NextResponse.json({ error: 'bookName is required' }, { status: 400 });
            }

            const entityType = (upload.entityType ?? DEFAULT_ENTITY_TYPE[source]) as EntityType;
            if (!ENTITY_TYPES.includes(entityType)) {
                return NextResponse.json(
                    { error: `Invalid entity type: ${upload.entityType}` },
                    { status: 400 }
                );
            }

            const result = await commitBusinessImport(user.id, source, {
                ...toPreviewInput(upload),
                bookName: upload.bookName,
                currency: upload.currency ?? 'USD',
                entityType,
                filename: upload.filename,
            });

            return NextResponse.json({ success: true, ...result });
        } catch (error) {
            console.error(`${label} import failed:`, error);
            const message = error instanceof Error ? error.message : `${label} import failed`;
            // Parse/validation problems reported by the service are caller-fixable.
            const clientFacing =
                message.startsWith('No importable transactions') ||
                message.startsWith('Book name is required') ||
                message.startsWith('Could not find');
            return NextResponse.json(
                { error: clientFacing ? message : `${label} import failed` },
                { status: clientFacing ? 400 : 500 }
            );
        }
    };
}
