/**
 * Book Settings Service
 *
 * Per-book settings stored in gnucash_web_book_settings (created by db-init).
 * Currently the only setting is the period lock date: transactions posted on
 * or before `lock_date` are closed and must not be mutated.
 *
 * The table is intentionally NOT in the Prisma schema (GnuCash DBs reject
 * `prisma db push`), so access goes through raw SQL.
 */

import prisma from '@/lib/prisma';
import { invalidatePeriodLockCache } from './period-lock.service';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface BookSettings {
    bookGuid: string;
    /** ISO YYYY-MM-DD, or null when the book has no locked period. */
    lockDate: string | null;
}

/** Format a Postgres DATE (returned as a JS Date at UTC midnight) as YYYY-MM-DD. */
function toIsoDate(value: Date | string | null): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.slice(0, 10);
    return value.toISOString().slice(0, 10);
}

/** Read the settings row for a book (lock date null when unset/absent). */
export async function getBookSettings(bookGuid: string): Promise<BookSettings> {
    const rows = await prisma.$queryRaw<{ lock_date: Date | string | null }[]>`
        SELECT lock_date FROM gnucash_web_book_settings WHERE book_guid = ${bookGuid}
    `;
    return {
        bookGuid,
        lockDate: rows.length > 0 ? toIsoDate(rows[0].lock_date) : null,
    };
}

/** The book's period lock date as YYYY-MM-DD, or null when unlocked. */
export async function getLockDate(bookGuid: string): Promise<string | null> {
    return (await getBookSettings(bookGuid)).lockDate;
}

/**
 * Set (or clear, with null) the book's period lock date.
 * Admin-only — enforce `requireRole('admin')` at the API layer.
 */
export async function setLockDate(bookGuid: string, lockDate: string | null): Promise<BookSettings> {
    if (lockDate !== null && !ISO_DATE_RE.test(lockDate)) {
        throw new Error('lockDate must be YYYY-MM-DD or null');
    }
    await prisma.$executeRaw`
        INSERT INTO gnucash_web_book_settings (book_guid, lock_date)
        VALUES (${bookGuid}, ${lockDate}::date)
        ON CONFLICT (book_guid)
        DO UPDATE SET lock_date = EXCLUDED.lock_date, updated_at = CURRENT_TIMESTAMP
    `;
    invalidatePeriodLockCache(bookGuid);
    return { bookGuid, lockDate };
}
