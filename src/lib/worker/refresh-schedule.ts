/**
 * Price-refresh schedule resolution for the background worker.
 *
 * Extracted from worker.ts so the two rules that matter here are testable
 * without booting BullMQ, Redis, or Postgres:
 *
 *  1. A user's refresh schedule targets the books that user is actually
 *     AUTHORIZED for. Recovery previously read a per-user preference and then
 *     scheduled `books.findFirst()` -- an arbitrary book, chosen by whatever
 *     order Postgres felt like returning. On any multi-book deployment that
 *     refreshed prices against a book the user may hold no permission on while
 *     the book they enabled refresh for went stale.
 *
 *  2. A stored refresh time is VALIDATED before it reaches a timer. `new
 *     Date().setUTCHours(NaN, ...)` yields an Invalid Date, so a malformed
 *     preference makes the delay computation return NaN; `setTimeout(fn, NaN)`
 *     is coerced to 0, fires immediately, reschedules, and spins the worker in
 *     a hot loop. Malformed values are skipped and logged instead.
 *
 * This module is intentionally dependency-free (no Prisma import) so worker.ts
 * can import it statically without pulling a connection pool into scope.
 */

/** Used when a user has enabled refresh but stored no time of their own. */
export const DEFAULT_REFRESH_TIME = '21:00';

/** Strict 24-hour HH:MM. Rejects '9:00', '24:00', '21:60', '21:00:00'. */
const HH_MM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/**
 * Validate a stored refresh time.
 *
 * Preferences are JSON-encoded free text written by an API route, so the value
 * arriving here can be any JSON scalar, an out-of-range time, or garbage.
 * Returns the canonical `HH:MM` string, or null if the value cannot be trusted.
 */
export function normalizeRefreshTime(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return HH_MM.test(trimmed) ? trimmed : null;
}

/**
 * Milliseconds until the next occurrence of `timeStr` (UTC), or null if the
 * time is malformed.
 *
 * Returning null rather than NaN is the whole point: every caller must decide
 * explicitly what to do with an unusable time, and none of them can
 * accidentally hand NaN to setTimeout. The result is always >= 1, so a target
 * landing exactly on `now` schedules tomorrow instead of firing in a tight loop.
 */
export function msUntilNextUtcTime(timeStr: string, now: Date = new Date()): number | null {
    const normalized = normalizeRefreshTime(timeStr);
    if (!normalized) return null;

    const [hours, minutes] = normalized.split(':').map(Number);
    const target = new Date(now);
    target.setUTCHours(hours, minutes, 0, 0);

    if (target.getTime() <= now.getTime()) {
        target.setUTCDate(target.getUTCDate() + 1);
    }

    return target.getTime() - now.getTime();
}

/** One book to schedule, and the user whose preference asked for it. */
export interface RefreshScheduleTarget {
    userId: number;
    bookGuid: string;
    refreshTime: string;
}

/**
 * Data access the resolver needs, injected so the rules above can be tested
 * against fixtures. worker.ts wires these to the real preference table and to
 * `getUserBooks()` from the permission service.
 */
export interface RefreshScheduleSources {
    /** User ids whose `refresh_enabled` preference is 'true'. */
    listRefreshEnabledUserIds(): Promise<number[]>;
    /**
     * Stored `refresh_time` preference, already JSON-decoded. Null/undefined
     * means "not set" (the default applies); anything else is validated.
     */
    readRefreshTime(userId: number): Promise<unknown>;
    /** Books the user holds a permission on. MUST be an authorization check. */
    listAuthorizedBooks(userId: number): Promise<ReadonlyArray<{ guid: string }>>;
    /** Diagnostics for skipped users. Defaults to console.warn. */
    onSkip?(message: string): void;
}

/**
 * Resolve the set of (book, time) pairs the worker should arm timers for.
 *
 * Skips -- never throws, never falls back to an arbitrary book:
 *  - a malformed stored time (logged; the user gets no schedule rather than a
 *    silently invented one, and critically no NaN delay),
 *  - a user with no authorized books,
 *  - a lookup that fails for one user, so one bad row cannot wipe out recovery
 *    for everybody else.
 *
 * Books are de-duplicated: timers are keyed by book, so when two users share a
 * book the first resolved schedule wins and the collision is logged.
 */
export async function resolvePriceRefreshTargets(
    sources: RefreshScheduleSources,
): Promise<RefreshScheduleTarget[]> {
    const onSkip = sources.onSkip ?? ((message: string) => console.warn(message));
    const targets: RefreshScheduleTarget[] = [];
    const claimedBooks = new Map<string, number>();

    const userIds = await sources.listRefreshEnabledUserIds();

    for (const userId of userIds) {
        try {
            const raw = await sources.readRefreshTime(userId);

            // Absent preference -> documented default. Present but unusable ->
            // skip, because guessing a time the user never chose is worse than
            // not refreshing, and NaN would spin the worker.
            const refreshTime = raw === null || raw === undefined
                ? DEFAULT_REFRESH_TIME
                : normalizeRefreshTime(raw);

            if (!refreshTime) {
                onSkip(
                    `[schedule] user ${userId}: refresh_time ${JSON.stringify(raw)} is not a valid HH:MM (UTC) — skipping`,
                );
                continue;
            }

            const books = await sources.listAuthorizedBooks(userId);
            if (books.length === 0) {
                onSkip(`[schedule] user ${userId}: refresh enabled but no authorized books — skipping`);
                continue;
            }

            for (const book of books) {
                const claimedBy = claimedBooks.get(book.guid);
                if (claimedBy !== undefined) {
                    onSkip(
                        `[schedule] book ${book.guid} already scheduled for user ${claimedBy}; ignoring user ${userId}`,
                    );
                    continue;
                }
                claimedBooks.set(book.guid, userId);
                targets.push({ userId, bookGuid: book.guid, refreshTime });
            }
        } catch (err) {
            onSkip(`[schedule] user ${userId}: failed to resolve refresh schedule — skipping: ${String(err)}`);
        }
    }

    return targets;
}
