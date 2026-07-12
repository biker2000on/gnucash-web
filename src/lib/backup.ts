import prisma from '@/lib/prisma';
import { getStorageBackend } from '@/lib/storage/storage-backend';

/**
 * Scheduled book backups.
 *
 * Each run exports every book to compressed GnuCash XML (desktop-compatible)
 * via the existing exporter, stores it through the storage abstraction
 * (filesystem or S3 — same backend as receipts), records it in a lazily
 * created gnucash_web_backups table, and prunes old backups per book beyond
 * the retention count (BACKUP_RETENTION, default 30).
 */

export interface BackupRecord {
    id: number;
    bookGuid: string;
    bookName: string | null;
    storageKey: string;
    sizeBytes: number;
    createdAt: Date;
}

export function backupRetention(): number {
    const n = parseInt(process.env.BACKUP_RETENTION || '30', 10);
    return Number.isFinite(n) && n > 0 ? n : 30;
}

/** Pure helper: which backups (sorted or not) fall beyond the newest `keep`. */
export function selectBackupsToPrune<T extends { createdAt: Date }>(backups: T[], keep: number): T[] {
    if (keep <= 0) return [];
    return [...backups]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(keep);
}

export function backupStorageKey(bookGuid: string, when: Date): string {
    const stamp = when.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `backups/${bookGuid}/${stamp}.gnucash`;
}

let ensurePromise: Promise<void> | null = null;

export function ensureBackupsTable(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await prisma.$executeRawUnsafe(`
                DO $$
                BEGIN
                  PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_backups_schema'));

                  CREATE TABLE IF NOT EXISTS gnucash_web_backups (
                    id SERIAL PRIMARY KEY,
                    book_guid VARCHAR(32) NOT NULL,
                    storage_key TEXT NOT NULL,
                    size_bytes BIGINT NOT NULL DEFAULT 0,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                  );

                  CREATE INDEX IF NOT EXISTS idx_backups_book_created
                    ON gnucash_web_backups(book_guid, created_at DESC);
                END $$;
            `);
        })();
    }
    return ensurePromise;
}

interface BackupRow {
    id: number;
    book_guid: string;
    storage_key: string;
    size_bytes: bigint;
    created_at: Date;
}

function toRecord(row: BackupRow, bookName: string | null): BackupRecord {
    return {
        id: row.id,
        bookGuid: row.book_guid,
        bookName,
        storageKey: row.storage_key,
        sizeBytes: Number(row.size_bytes),
        createdAt: row.created_at,
    };
}

async function bookNameFor(rootAccountGuid: string): Promise<string | null> {
    const root = await prisma.accounts.findUnique({
        where: { guid: rootAccountGuid },
        select: { name: true },
    });
    if (!root) return null;
    if (root.name && root.name.toLowerCase() !== 'root account') return root.name;
    const firstChild = await prisma.accounts.findFirst({
        where: { parent_guid: rootAccountGuid },
        select: { name: true },
    });
    return firstChild?.name ?? root.name;
}

export interface BookBackupResult {
    bookGuid: string;
    storageKey: string;
    sizeBytes: number;
    pruned: number;
}

export async function runBookBackup(bookGuid: string, rootAccountGuid: string): Promise<BookBackupResult> {
    await ensureBackupsTable();

    const { exportBookData } = await import('@/lib/gnucash-xml/exporter');
    const { buildGnuCashXml, compressGnuCashXml } = await import('@/lib/gnucash-xml/builder');

    const data = await exportBookData(rootAccountGuid);
    const xml = buildGnuCashXml(data);
    const compressed = compressGnuCashXml(xml);
    const buffer = Buffer.from(compressed);

    const key = backupStorageKey(bookGuid, new Date());
    const storage = await getStorageBackend();
    await storage.put(key, buffer, 'application/gzip');

    await prisma.$executeRaw`
        INSERT INTO gnucash_web_backups (book_guid, storage_key, size_bytes)
        VALUES (${bookGuid}, ${key}, ${buffer.length})
    `;

    // Retention: prune oldest beyond the keep count
    const all = await prisma.$queryRaw<BackupRow[]>`
        SELECT id, book_guid, storage_key, size_bytes, created_at
        FROM gnucash_web_backups
        WHERE book_guid = ${bookGuid}
        ORDER BY created_at DESC
    `;
    const prune = selectBackupsToPrune(
        all.map(r => ({ ...r, createdAt: r.created_at })),
        backupRetention(),
    );
    for (const victim of prune) {
        try {
            await storage.delete(victim.storage_key);
        } catch (err) {
            console.warn(`Backup prune: failed to delete ${victim.storage_key} from storage:`, err);
        }
        await prisma.$executeRaw`DELETE FROM gnucash_web_backups WHERE id = ${victim.id}`;
    }

    return { bookGuid, storageKey: key, sizeBytes: buffer.length, pruned: prune.length };
}

export interface AllBackupsResult {
    results: BookBackupResult[];
    errors: Array<{ bookGuid: string; error: string }>;
}

export async function runAllBackups(): Promise<AllBackupsResult> {
    const books = await prisma.books.findMany({
        select: { guid: true, root_account_guid: true },
    });
    const results: BookBackupResult[] = [];
    const errors: Array<{ bookGuid: string; error: string }> = [];
    for (const book of books) {
        try {
            results.push(await runBookBackup(book.guid, book.root_account_guid));
        } catch (err) {
            errors.push({ bookGuid: book.guid, error: err instanceof Error ? err.message : String(err) });
        }
    }
    return { results, errors };
}

export async function listBackups(bookGuid: string): Promise<BackupRecord[]> {
    await ensureBackupsTable();
    const rows = await prisma.$queryRaw<BackupRow[]>`
        SELECT id, book_guid, storage_key, size_bytes, created_at
        FROM gnucash_web_backups
        WHERE book_guid = ${bookGuid}
        ORDER BY created_at DESC
    `;
    const book = await prisma.books.findUnique({
        where: { guid: bookGuid },
        select: { root_account_guid: true },
    });
    const name = book ? await bookNameFor(book.root_account_guid) : null;
    return rows.map(r => toRecord(r, name));
}

export async function getBackup(id: number, bookGuid: string): Promise<{ record: BackupRecord; content: Buffer } | null> {
    await ensureBackupsTable();
    const rows = await prisma.$queryRaw<BackupRow[]>`
        SELECT id, book_guid, storage_key, size_bytes, created_at
        FROM gnucash_web_backups
        WHERE id = ${id} AND book_guid = ${bookGuid}
        LIMIT 1
    `;
    if (rows.length === 0) return null;
    const storage = await getStorageBackend();
    const content = await storage.get(rows[0].storage_key);
    return { record: toRecord(rows[0], null), content };
}

export async function deleteBackup(id: number, bookGuid: string): Promise<boolean> {
    await ensureBackupsTable();
    const rows = await prisma.$queryRaw<BackupRow[]>`
        SELECT id, book_guid, storage_key, size_bytes, created_at
        FROM gnucash_web_backups
        WHERE id = ${id} AND book_guid = ${bookGuid}
        LIMIT 1
    `;
    if (rows.length === 0) return false;
    const storage = await getStorageBackend();
    try {
        await storage.delete(rows[0].storage_key);
    } catch (err) {
        console.warn(`Failed to delete backup object ${rows[0].storage_key}:`, err);
    }
    await prisma.$executeRaw`DELETE FROM gnucash_web_backups WHERE id = ${id}`;
    return true;
}
