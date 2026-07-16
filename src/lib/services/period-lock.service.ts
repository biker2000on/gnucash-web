/**
 * Period Lock Guard
 *
 * Enforces the book's period lock date (gnucash_web_book_settings.lock_date):
 * any mutation that creates, updates, or deletes ledger data dated on or
 * before the lock date must be rejected. The rule is date-based:
 *
 *   post_date <= lock_date  → blocked (the boundary day itself is locked)
 *   post_date >  lock_date  → allowed
 *
 * Mutation paths call `assertNotLocked` (services — throws PeriodLockedError)
 * or `withPeriodLockCheck` (API routes — returns a ready NextResponse), with
 * every relevant date: the NEW post date for creates, and the EXISTING post
 * date plus any new date for updates/deletes.
 *
 * Lock dates are cached per book in a naive in-process Map with a short TTL
 * so bulk operations don't re-query per transaction.
 */

import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

export class PeriodLockedError extends Error {
    readonly code = 'PERIOD_LOCKED';
    /** ISO YYYY-MM-DD lock date the mutation collided with. */
    readonly lockDate: string;

    constructor(lockDate: string) {
        super(`Period locked: transactions on or before ${lockDate} are closed`);
        this.name = 'PeriodLockedError';
        this.lockDate = lockDate;
    }
}

export type LockableDate = Date | string | null | undefined;

// ---------------------------------------------------------------------------
// Lock-date cache (naive per-process Map, 5s TTL)
// ---------------------------------------------------------------------------

const LOCK_CACHE_TTL_MS = 5_000;
const lockCache = new Map<string, { lockDate: string | null; expiresAt: number }>();

/** Drop cached lock dates (one book, or all when omitted). */
export function invalidatePeriodLockCache(bookGuid?: string): void {
    if (bookGuid) lockCache.delete(bookGuid);
    else lockCache.clear();
}

/** Normalize a date-ish value to its ISO YYYY-MM-DD day (UTC). */
export function toIsoDateString(value: Date | string): string {
    if (typeof value === 'string') return value.slice(0, 10);
    return value.toISOString().slice(0, 10);
}

/** The book's lock date (YYYY-MM-DD, or null), cached for a few seconds. */
export async function getCachedLockDate(bookGuid: string): Promise<string | null> {
    const cached = lockCache.get(bookGuid);
    if (cached && cached.expiresAt > Date.now()) return cached.lockDate;

    const rows = await prisma.$queryRaw<{ lock_date: Date | string | null }[]>`
        SELECT lock_date FROM gnucash_web_book_settings WHERE book_guid = ${bookGuid}
    `;
    const raw = rows.length > 0 ? rows[0].lock_date : null;
    const lockDate = raw == null ? null : toIsoDateString(raw);
    lockCache.set(bookGuid, { lockDate, expiresAt: Date.now() + LOCK_CACHE_TTL_MS });
    return lockDate;
}

// ---------------------------------------------------------------------------
// Core checks
// ---------------------------------------------------------------------------

/**
 * Pure boundary rule: returns the first date that falls inside the locked
 * period (day <= lockDate), or null when everything is allowed.
 * Null/undefined entries are skipped (e.g. template transactions carry no
 * post date and are never period-locked).
 */
export function findLockedDate(lockDate: string | null, dates: LockableDate[]): string | null {
    if (!lockDate) return null;
    for (const d of dates) {
        if (d == null) continue;
        const day = toIsoDateString(d);
        if (day <= lockDate) return day;
    }
    return null;
}

/**
 * Throw PeriodLockedError when any of `dates` falls on or before the book's
 * lock date. Service-layer guard; pair with `periodLockedResponse` (or a
 * PeriodLockedError branch in the route's error mapper) at the API layer.
 */
export async function assertNotLocked(bookGuid: string, dates: LockableDate[]): Promise<void> {
    const lockDate = await getCachedLockDate(bookGuid);
    if (findLockedDate(lockDate, dates) !== null) {
        throw new PeriodLockedError(lockDate!);
    }
}

/**
 * Throw PeriodLockedError when the transaction's post_date falls in the
 * locked period. Missing transactions pass (the caller 404s on its own).
 */
export async function assertTxnMutable(bookGuid: string, txGuid: string): Promise<void> {
    const lockDate = await getCachedLockDate(bookGuid);
    if (!lockDate) return;
    const tx = await prisma.transactions.findUnique({
        where: { guid: txGuid },
        select: { post_date: true },
    });
    if (!tx) return;
    await assertNotLocked(bookGuid, [tx.post_date]);
}

// ---------------------------------------------------------------------------
// API-route helpers
// ---------------------------------------------------------------------------

/** The standard period-locked JSON payload (spec'd shape, 400 status). */
export function periodLockedResponse(error: PeriodLockedError): NextResponse {
    return NextResponse.json(
        {
            error: `Period locked: transactions on or before ${error.lockDate} are closed`,
            code: 'PERIOD_LOCKED',
        },
        { status: 400 },
    );
}

/**
 * Route-level guard: returns the ready-to-send 400 PERIOD_LOCKED response
 * when any date is locked, or null when the mutation may proceed.
 *
 *     const lockError = await withPeriodLockCheck(bookGuid, [body.post_date]);
 *     if (lockError) return lockError;
 */
export async function withPeriodLockCheck(
    bookGuid: string,
    dates: LockableDate[],
): Promise<NextResponse | null> {
    try {
        await assertNotLocked(bookGuid, dates);
        return null;
    } catch (err) {
        if (err instanceof PeriodLockedError) return periodLockedResponse(err);
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Book resolution for session-less contexts (engines, workers)
// ---------------------------------------------------------------------------

/**
 * Resolve the book a given account belongs to by walking up the account tree
 * to its root and matching books.root_account_guid. Returns null when the
 * account is orphaned / unknown. Works without a session (worker-safe).
 */
export async function getBookGuidForAccount(accountGuid: string): Promise<string | null> {
    const rows = await prisma.$queryRaw<{ guid: string }[]>`
        WITH RECURSIVE up AS (
            SELECT guid, parent_guid FROM accounts WHERE guid = ${accountGuid}
            UNION ALL
            SELECT a.guid, a.parent_guid FROM accounts a
            JOIN up ON up.parent_guid = a.guid
        )
        SELECT b.guid FROM books b
        JOIN up ON up.guid = b.root_account_guid
        LIMIT 1
    `;
    return rows.length > 0 ? rows[0].guid : null;
}

/** Resolve a book guid from its root account guid. */
export async function getBookGuidForRoot(rootAccountGuid: string): Promise<string | null> {
    const book = await prisma.books.findFirst({
        where: { root_account_guid: rootAccountGuid },
        select: { guid: true },
    });
    return book?.guid ?? null;
}

/**
 * `assertNotLocked` keyed by an account inside the book instead of the book
 * guid itself — for engines that never see the book guid. No-op when the
 * account cannot be resolved to a book.
 */
export async function assertAccountNotLocked(
    accountGuid: string,
    dates: LockableDate[],
): Promise<void> {
    const bookGuid = await getBookGuidForAccount(accountGuid);
    if (!bookGuid) return;
    await assertNotLocked(bookGuid, dates);
}
