/**
 * Shared Next.js route handlers for the personal-finance importers.
 *
 * Each source's preview/commit route is a one-liner:
 *
 *     export const POST = makePersonalPreviewRoute('mint');
 *     export const POST = makePersonalCommitRoute('mint');
 *
 * Both are stateless: the client re-sends the same file for commit, plus the
 * chosen account/category mappings, and the server re-parses it. Imports go
 * into the ACTIVE book (edit role required). Period-locked rows are skipped
 * by the service and surfaced in the response, not rejected wholesale.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookRootGuid, getBookAccountGuids } from '@/lib/book-scope';
import type { ImportLocaleId } from './parse-locale';
import type { PersonalSource } from './personal-import';
import {
    previewPersonalImport,
    commitPersonalImport,
    PERSONAL_SOURCE_LABELS,
    type PersonalImportInput,
    type PersonalBookContext,
} from './personal-import.service';

const MAX_CONTENT_BYTES = 15 * 1024 * 1024; // 15 MB

interface ParsedUpload {
    input: PersonalImportInput;
}

function parseMappings(raw: FormDataEntryValue | null): Record<string, string> {
    if (!raw || typeof raw !== 'string') return {};
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string' && v) out[k] = v;
        }
        return out;
    } catch {
        return {};
    }
}

async function readUpload(request: NextRequest): Promise<ParsedUpload | NextResponse> {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
        return NextResponse.json(
            { error: 'Expected multipart/form-data with a "file" field' },
            { status: 400 }
        );
    }

    let formData: FormData;
    try {
        formData = await request.formData();
    } catch {
        return NextResponse.json({ error: 'Could not read the upload' }, { status: 400 });
    }

    let content = '';
    let filename: string | null = null;
    const file = formData.get('file');
    if (file instanceof File && file.size > 0) {
        if (file.size > MAX_CONTENT_BYTES) {
            return NextResponse.json({ error: 'File too large (15 MB max)' }, { status: 413 });
        }
        content = await file.text();
        filename = file.name || null;
    } else {
        const raw = formData.get('content');
        if (typeof raw === 'string') content = raw;
    }
    if (!content.trim()) {
        return NextResponse.json({ error: 'A CSV file is required' }, { status: 400 });
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
        return NextResponse.json({ error: 'Content too large (15 MB max)' }, { status: 413 });
    }

    const localeRaw = formData.get('locale');
    const locale: ImportLocaleId = localeRaw === 'eu' ? 'eu' : 'us';

    return {
        input: {
            content,
            locale,
            filename,
            accountMappings: parseMappings(formData.get('accountMappings')),
            categoryMappings: parseMappings(formData.get('categoryMappings')),
            skipDuplicates: String(formData.get('skipDuplicates') ?? 'true') !== 'false',
        },
    };
}

async function resolveContext(bookGuid: string): Promise<PersonalBookContext> {
    const rootGuid = await getActiveBookRootGuid();
    const bookAccountGuids = await getBookAccountGuids();
    return { bookGuid, rootGuid, bookAccountGuids };
}

function errorResponse(source: PersonalSource, phase: 'preview' | 'commit', error: unknown): NextResponse {
    const label = PERSONAL_SOURCE_LABELS[source];
    console.error(`${label} ${phase} failed:`, error);
    const message = error instanceof Error ? error.message : `${label} ${phase} failed`;
    if (message === 'NO_BOOKS') {
        return NextResponse.json(
            { error: 'No books exist yet; create or import a book first.' },
            { status: 400 }
        );
    }
    // Parse/validation problems reported by the service are caller-fixable.
    const clientFacing =
        message.startsWith('No importable transactions') ||
        message.startsWith('Could not find');
    return NextResponse.json(
        { error: clientFacing ? message : `${label} ${phase} failed` },
        { status: clientFacing ? 400 : 500 }
    );
}

/**
 * POST /api/import-export/{source}/preview
 *
 * Multipart form data:
 *   file             — the source's transactions CSV export
 *   locale           — 'us' (default) | 'eu' (day-first dates, comma decimals)
 *   accountMappings  — JSON { [sourceAccountName]: guid | 'new:BANK' | 'new:CREDIT' }
 *   categoryMappings — JSON { [categoryLabel]: guid | 'new' }
 *   skipDuplicates   — 'true' (default) | 'false'
 *
 * Returns the parsed preview (no writes). Requires the edit role.
 */
export function makePersonalPreviewRoute(source: PersonalSource) {
    return async function POST(request: NextRequest) {
        try {
            const roleResult = await requireRole('edit');
            if (roleResult instanceof NextResponse) return roleResult;

            const upload = await readUpload(request);
            if (upload instanceof NextResponse) return upload;

            const ctx = await resolveContext(roleResult.bookGuid);
            const preview = await previewPersonalImport(source, upload.input, ctx);
            return NextResponse.json(preview);
        } catch (error) {
            return errorResponse(source, 'preview', error);
        }
    };
}

/**
 * POST /api/import-export/{source}/commit
 *
 * Same multipart fields as preview. Creates the mapped accounts and two-split
 * transactions in the ACTIVE book, skipping duplicates (when requested) and
 * period-locked rows, then records a gnucash_web_import_batches row.
 */
export function makePersonalCommitRoute(source: PersonalSource) {
    return async function POST(request: NextRequest) {
        try {
            const roleResult = await requireRole('edit');
            if (roleResult instanceof NextResponse) return roleResult;
            const { user } = roleResult;

            const upload = await readUpload(request);
            if (upload instanceof NextResponse) return upload;

            const ctx = await resolveContext(roleResult.bookGuid);
            const result = await commitPersonalImport(user.id, source, upload.input, ctx);
            return NextResponse.json({ success: true, ...result });
        } catch (error) {
            return errorResponse(source, 'commit', error);
        }
    };
}
