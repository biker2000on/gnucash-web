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
 *  2. "Enabled" means ONE thing. The settings route and startup recovery each
 *     used to decide it for themselves -- the route on the parsed preference
 *     (`true` or the string `'true'`), recovery as a SQL comparison against the
 *     literal 'true'. They disagreed on a representation that really occurs, so
 *     a user could be enabled on save and invisible to recovery. Both callers
 *     now go through `isRefreshEnabled`.
 *
 *  3. A stored refresh time is VALIDATED before it reaches a timer. `new
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

/** The preference key both the settings route and recovery read enablement from. */
export const REFRESH_ENABLED_KEY = 'refresh_enabled';

/**
 * THE single definition of "this user has price refresh switched on".
 *
 * Every persisted representation, and what it must resolve to. `setPreference`
 * JSON-serializes whatever the PATCH body carried, so the column holds JSON
 * text and the set below is what can actually be in it:
 *
 *   stored column text | JSON.parse       | verdict
 *   -------------------+------------------+---------
 *   `true`             | boolean true     | ENABLED
 *   `false`            | boolean false    | disabled
 *   `"true"`           | string 'true'    | ENABLED   <- the row recovery used to miss
 *   `"false"`          | string 'false'   | disabled  <- must NOT be re-enabled
 *   (row absent)       | -- (default)     | disabled
 *   malformed JSON     | throws           | disabled
 *   anything else      | 1, null, {}, ... | disabled
 *
 * Both directions are failures with teeth. Under-recognizing silently loses a
 * schedule the user turned ON; over-recognizing silently turns one back on
 * after they turned it OFF. So this is an exact match on exactly two values,
 * never a truthiness or substring test: `Boolean('false')` is TRUE, and a
 * permissive `LIKE '%true%'` matches any stored text that merely mentions the
 * word. Either would re-enable a schedule the user deliberately switched off.
 *
 * Takes the PARSED value, so callers holding a `getPreference` result and
 * callers holding a raw column both funnel through the same rule.
 */
export function isRefreshEnabled(parsed: unknown): boolean {
    return parsed === true || parsed === 'true';
}

/**
 * The same predicate, applied to a RAW `preference_value` column.
 *
 * Startup recovery scans the preference table directly rather than calling
 * `getPreference` per user, so it holds JSON text, not a parsed value. It must
 * still reach the identical verdict — encoding enablement a second time as a
 * SQL string comparison is what broke this: `preference_value = 'true'` matches
 * a boolean-true row and MISSES a legitimately stored `"true"`, so a user who
 * had refresh on lost their schedule at the next worker restart, silently and
 * until they next saved settings.
 */
export function isRefreshEnabledStoredValue(
    raw: string | null | undefined,
    onInvalidStoredValue?: () => void,
): boolean {
    if (typeof raw !== 'string') return false;
    try {
        return isRefreshEnabled(JSON.parse(raw));
    } catch {
        // Recovery reads the raw column instead of getPreference, so it owns
        // the safe corrupt-row diagnostic when its caller supplies one.
        onInvalidStoredValue?.();
        return false;
    }
}

/** One `refresh_enabled` row as recovery reads it. */
export interface RefreshEnabledRow {
    user_id: number;
    preference_value: string;
}

/**
 * Users whose stored preference means "enabled", from the candidate rows.
 *
 * Recovery selects every `refresh_enabled` row (at most one per user — the
 * table is unique on user + key) and decides enablement HERE, through the
 * shared predicate, instead of asking Postgres to compare strings.
 */
export function selectRefreshEnabledUserIds(
    rows: ReadonlyArray<RefreshEnabledRow>,
): number[] {
    return rows
        .filter(row => isRefreshEnabledStoredValue(row.preference_value, () => {
            // Never log preference content or JSON.parse's error: both can
            // disclose user-controlled financial data. This is enough to find
            // the affected row and repair it safely.
            console.warn(
                `[schedule] user ${row.user_id}: stored value for '${REFRESH_ENABLED_KEY}' ` +
                `is not valid JSON (${row.preference_value.length} chars) — skipping`,
            );
        }))
        .map(row => row.user_id);
}

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
    /**
     * User ids whose stored `refresh_enabled` preference means enabled, as
     * decided by `isRefreshEnabledStoredValue` — never by a SQL string compare.
     */
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

/**
 * Payload of a `schedule-changed` job, as it arrives off the queue.
 *
 * `bookGuid` is optional only because jobs enqueued by an older build may
 * already be sitting in Redis without one. Every current producer
 * (`signalScheduleChanged`, called from the settings route with the bookGuid
 * the request was authorized against) always sets it.
 */
export interface ScheduleChangeRequest {
    /**
     * Deprecated and IGNORED. Documented here so it is clear that the handler
     * does not, and must not, resolve a book from it.
     */
    userId?: number;
    bookGuid?: string;
    enabled?: boolean;
    refreshTime?: string;
}

/** Timer operations the handler is allowed to perform, injected for testing. */
export interface ScheduleChangeEffects {
    setSchedule(bookGuid: string, refreshTime: string): void;
    clearSchedule(bookGuid: string): void;
    /** Diagnostics for the ignored case. Defaults to console.error. */
    onSkip?(message: string): void;
}

/** What the handler did. `'ignored'` means no timer was touched. */
export type ScheduleChangeOutcome = 'set' | 'cleared' | 'ignored';

/**
 * Apply a `schedule-changed` signal to exactly the book it names — or to
 * nothing at all.
 *
 * FAIL CLOSED. A request with no bookGuid used to fall back to
 * `books.findFirst()`, so a legacy job carrying only `{enabled, refreshTime}`
 * could arm or cancel a price-refresh timer on whichever book Postgres
 * happened to return first — an authorization AND targeting bug, unrelated to
 * (and untouched by) validating the time. There is no safe guess available
 * here: the deprecated `userId` cannot authorize a book, and any book we pick
 * is a book nobody asked for. Doing nothing is strictly better than doing the
 * wrong thing to an arbitrary book.
 *
 * Nothing is lost by ignoring such a job: `recoverSchedules()` rebuilds every
 * timer from the preference table and `getUserBooks()` on the next worker
 * start, and any settings save re-signals with a bookGuid attached.
 *
 * That rebuild guarantee is only as good as recovery's idea of who is enabled,
 * which is why `isRefreshEnabled` is shared rather than restated in SQL: while
 * recovery matched the raw literal 'true', users stored as the JSON string
 * `"true"` were omitted from the rebuild entirely, and failing closed here
 * would have left them with no schedule at all.
 */
export function applyScheduleChange(
    request: ScheduleChangeRequest,
    effects: ScheduleChangeEffects,
): ScheduleChangeOutcome {
    const onSkip = effects.onSkip ?? ((message: string) => console.error(message));
    const bookGuid = typeof request.bookGuid === 'string' ? request.bookGuid.trim() : '';

    if (!bookGuid) {
        onSkip(
            '[schedule] schedule-changed job carries no bookGuid — ignoring. ' +
            'Refusing to guess a book: an arbitrary book is not the one the ' +
            'signal was authorized for. Schedules for this book are rebuilt ' +
            'from authorized books on the next worker start, or on the next ' +
            'settings save.',
        );
        return 'ignored';
    }

    if (request.enabled) {
        effects.setSchedule(bookGuid, request.refreshTime || DEFAULT_REFRESH_TIME);
        return 'set';
    }

    effects.clearSchedule(bookGuid);
    return 'cleared';
}
