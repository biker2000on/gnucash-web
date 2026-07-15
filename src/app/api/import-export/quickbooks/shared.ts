import { NextRequest, NextResponse } from 'next/server';

/** Shared multipart parsing for the QuickBooks preview + commit routes. */

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB per CSV file
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024; // 50 MB for ZIP/XLSX archives
export const MAX_JOURNAL_LINES = 100_000;

const ARCHIVE_EXT = /\.(zip|xlsx|xlsm|xls)$/i;

export interface QboUpload {
    journalContent: string | null;
    coaContent: string | null;
    /** ZIP from QBO "Export data" or a single XLSX workbook */
    archive: { filename: string; data: Uint8Array } | null;
    /** Chart of Accounts uploaded as an XLSX workbook */
    coaArchive: { filename: string; data: Uint8Array } | null;
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

async function readArchiveFile(
    file: File,
    label: string
): Promise<{ filename: string; data: Uint8Array } | NextResponse> {
    if (file.size > MAX_ARCHIVE_BYTES) {
        return NextResponse.json({ error: `${label} too large (50 MB max)` }, { status: 413 });
    }
    return { filename: file.name, data: new Uint8Array(await file.arrayBuffer()) };
}

export async function readQboUpload(request: NextRequest): Promise<QboUpload | NextResponse> {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
        return NextResponse.json(
            { error: 'Expected multipart/form-data with an "archive" or "journal" file' },
            { status: 400 }
        );
    }

    let formData: FormData;
    try {
        formData = await request.formData();
    } catch {
        return NextResponse.json({ error: 'Could not read the upload' }, { status: 400 });
    }

    let archive: QboUpload['archive'] = null;
    let journalContent: string | null = null;
    let journalName: string | null = null;

    // New path: a single "archive" field (Export-data ZIP or XLSX workbook).
    const archiveFile = formData.get('archive');
    if (archiveFile instanceof File && archiveFile.size > 0) {
        if (!ARCHIVE_EXT.test(archiveFile.name)) {
            return NextResponse.json(
                { error: 'The archive must be a .zip (QuickBooks Export data) or .xlsx file.' },
                { status: 400 }
            );
        }
        const read = await readArchiveFile(archiveFile, 'Archive');
        if (read instanceof NextResponse) return read;
        archive = read;
    }

    // Legacy path: "journal" field. A .zip/.xlsx dropped here is promoted to
    // the archive path (same machinery); otherwise it is Journal CSV text.
    const journalFile = formData.get('journal');
    if (!archive && journalFile instanceof File && journalFile.size > 0) {
        if (ARCHIVE_EXT.test(journalFile.name)) {
            const read = await readArchiveFile(journalFile, 'Journal file');
            if (read instanceof NextResponse) return read;
            archive = read;
        } else {
            if (journalFile.size > MAX_FILE_BYTES) {
                return NextResponse.json({ error: 'Journal file too large (20 MB max)' }, { status: 413 });
            }
            journalContent = await journalFile.text();
            journalName = journalFile.name || null;
            if (!journalContent.trim()) {
                return NextResponse.json({ error: 'The Journal file is empty' }, { status: 400 });
            }
            if (countLines(journalContent) > MAX_JOURNAL_LINES) {
                return NextResponse.json(
                    { error: `Journal file has too many rows (${MAX_JOURNAL_LINES.toLocaleString()} max). Split the export into smaller date ranges.` },
                    { status: 413 }
                );
            }
        }
    }

    if (!archive && !journalContent) {
        return NextResponse.json(
            { error: 'A QuickBooks Export data ZIP or a Journal report CSV file is required' },
            { status: 400 }
        );
    }

    let coaContent: string | null = null;
    let coaArchive: QboUpload['coaArchive'] = null;
    const coaFile = formData.get('coa');
    if (coaFile instanceof File && coaFile.size > 0) {
        if (ARCHIVE_EXT.test(coaFile.name)) {
            const read = await readArchiveFile(coaFile, 'Chart of Accounts file');
            if (read instanceof NextResponse) return read;
            coaArchive = read;
        } else {
            if (coaFile.size > MAX_FILE_BYTES) {
                return NextResponse.json({ error: 'Chart of Accounts file too large (20 MB max)' }, { status: 413 });
            }
            coaContent = await coaFile.text();
        }
    }

    const str = (key: string): string | null => {
        const v = formData.get(key);
        return typeof v === 'string' && v.trim() ? v.trim() : null;
    };

    return {
        journalContent,
        coaContent,
        archive,
        coaArchive,
        bookName: str('bookName'),
        typeOverrides: parseOverrides(formData.get('typeOverrides')),
        entityType: str('entityType'),
        currency: str('currency'),
        filename: archive?.filename ?? journalName,
    };
}
