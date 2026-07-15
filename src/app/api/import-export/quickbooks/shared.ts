import { NextRequest, NextResponse } from 'next/server';

/** Shared multipart parsing for the QuickBooks preview + commit routes. */

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB per file
export const MAX_JOURNAL_LINES = 100_000;

export interface QboUpload {
    journalContent: string;
    coaContent: string | null;
    bookName: string | null;
    typeOverrides: Record<string, string>;
    entityType: string | null;
    currency: string | null;
    filename: string | null;
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

export async function readQboUpload(request: NextRequest): Promise<QboUpload | NextResponse> {
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

    const journalFile = formData.get('journal');
    if (!(journalFile instanceof File)) {
        return NextResponse.json({ error: 'A Journal report CSV file is required' }, { status: 400 });
    }
    if (journalFile.size > MAX_FILE_BYTES) {
        return NextResponse.json({ error: 'Journal file too large (20 MB max)' }, { status: 413 });
    }
    if (/\.xlsx?$/i.test(journalFile.name)) {
        return NextResponse.json(
            { error: 'XLSX is not supported — export the Journal report as CSV instead.' },
            { status: 400 }
        );
    }

    const journalContent = await journalFile.text();
    if (!journalContent.trim()) {
        return NextResponse.json({ error: 'The Journal file is empty' }, { status: 400 });
    }
    if (countLines(journalContent) > MAX_JOURNAL_LINES) {
        return NextResponse.json(
            { error: `Journal file has too many rows (${MAX_JOURNAL_LINES.toLocaleString()} max). Split the export into smaller date ranges.` },
            { status: 413 }
        );
    }

    let coaContent: string | null = null;
    const coaFile = formData.get('coa');
    if (coaFile instanceof File && coaFile.size > 0) {
        if (coaFile.size > MAX_FILE_BYTES) {
            return NextResponse.json({ error: 'Chart of Accounts file too large (20 MB max)' }, { status: 413 });
        }
        if (/\.xlsx?$/i.test(coaFile.name)) {
            return NextResponse.json(
                { error: 'XLSX is not supported — export the Chart of Accounts as CSV instead.' },
                { status: 400 }
            );
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
        filename: journalFile.name || null,
    };
}
