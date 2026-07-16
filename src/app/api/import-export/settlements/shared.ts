import { NextRequest, NextResponse } from 'next/server';
import { getActiveBookRootGuid, getBookAccountGuids } from '@/lib/book-scope';
import { isSettlementSource, type SettlementSource, type SettlementRole } from '@/lib/import/settlements';
import type {
    SettlementBookContext,
    SettlementImportInput,
    SettlementMappings,
} from '@/lib/import/settlement-import.service';

/** Shared multipart parsing for the settlement preview + commit routes. */

export const MAX_CONTENT_BYTES = 15 * 1024 * 1024; // 15 MB

const ROLES: SettlementRole[] = ['income', 'fees', 'clearing', 'bank'];

export interface SettlementUpload {
    source: SettlementSource;
    input: SettlementImportInput;
}

function parseMappings(raw: FormDataEntryValue | null): SettlementMappings {
    if (!raw || typeof raw !== 'string') return {};
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        const out: SettlementMappings = {};
        for (const role of ROLES) {
            const v = (parsed as Record<string, unknown>)[role];
            if (typeof v === 'string' && v) out[role] = v;
        }
        return out;
    } catch {
        return {};
    }
}

export async function readSettlementUpload(
    request: NextRequest
): Promise<SettlementUpload | NextResponse> {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
        return NextResponse.json(
            { error: 'Expected multipart/form-data with "file" and "source" fields' },
            { status: 400 }
        );
    }

    let formData: FormData;
    try {
        formData = await request.formData();
    } catch {
        return NextResponse.json({ error: 'Could not read the upload' }, { status: 400 });
    }

    const sourceRaw = String(formData.get('source') ?? '');
    if (!isSettlementSource(sourceRaw)) {
        return NextResponse.json(
            { error: 'source must be one of: stripe, square, paypal, shopify' },
            { status: 400 }
        );
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

    return {
        source: sourceRaw,
        input: {
            content,
            filename,
            locale: formData.get('locale') === 'eu' ? 'eu' : 'us',
            mappings: parseMappings(formData.get('mappings')),
            skipDuplicates: String(formData.get('skipDuplicates') ?? 'true') !== 'false',
        },
    };
}

export async function resolveSettlementContext(bookGuid: string): Promise<SettlementBookContext> {
    const rootGuid = await getActiveBookRootGuid();
    const bookAccountGuids = await getBookAccountGuids();
    return { bookGuid, rootGuid, bookAccountGuids };
}

export function settlementErrorResponse(phase: 'preview' | 'commit', error: unknown): NextResponse {
    console.error(`Settlement ${phase} failed:`, error);
    const message = error instanceof Error ? error.message : `Settlement ${phase} failed`;
    if (message === 'NO_BOOKS') {
        return NextResponse.json(
            { error: 'No books exist yet; create or import a book first.' },
            { status: 400 }
        );
    }
    // Parse/validation problems reported by the service are caller-fixable.
    const clientFacing =
        message.startsWith('No importable transactions') || message.startsWith('Could not find');
    return NextResponse.json(
        { error: clientFacing ? message : `Settlement ${phase} failed` },
        { status: clientFacing ? 400 : 500 }
    );
}
