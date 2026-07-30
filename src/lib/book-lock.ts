/**
 * Book-level advisory locking helpers.
 *
 * Serializes heavy per-book operations (lot scrubs, XML import, book delete,
 * account reparenting) using PostgreSQL advisory locks, following the
 * patterns already used at src/lib/planning/living-plan.ts (xact-scoped
 * pg_advisory_xact_lock) and src/lib/db.ts (session-scoped advisory lock).
 *
 * Transaction-scoped locks (pg_advisory_xact_lock / pg_try_advisory_xact_lock)
 * are released automatically at COMMIT/ROLLBACK — there is nothing to unlock.
 *
 * All lock keys are hashed with hashtext(), so a session-level lock taken via
 * `withDatabaseAdvisoryLock('book:X', ...)` (db.ts) and a transaction-level
 * lock taken here on the same key CONTEND with each other — that is
 * intentional (e.g. a running scrub-all blocks a concurrent XML import).
 */

/**
 * Minimal structural client type: any Prisma client / interactive-transaction
 * client. `$queryRaw` is optional so test doubles (in-memory fakes) that do
 * not implement raw queries degrade gracefully to "no locking" instead of
 * crashing — production Prisma clients always implement it.
 */
export interface MaybeRawClient {
    $queryRaw?<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/** Thrown when a try-lock fails: another operation on this book is running. */
export class BookBusyError extends Error {
    readonly code = 'BOOK_BUSY';
    constructor(
        public readonly bookGuid: string,
        public readonly operation?: string,
    ) {
        super(
            `Another operation on this book is in progress${operation ? ` (while attempting: ${operation})` : ''}. Try again shortly.`,
        );
        this.name = 'BookBusyError';
    }
}

/** Canonical advisory-lock key for a book. */
export function bookLockKey(bookGuid: string): string {
    return `book:${bookGuid}`;
}

/**
 * Blocking transaction-scoped lock on a book. Queues behind any other holder
 * (transaction- or session-scoped) of the same key. Released automatically at
 * transaction end.
 */
export async function acquireBookLock(
    tx: MaybeRawClient,
    bookGuid: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    operation?: string,
): Promise<void> {
    if (typeof tx.$queryRaw !== 'function') return; // test double — no raw support
    // ::text cast: pg_advisory_xact_lock returns void, which Prisma's
    // $queryRaw cannot deserialize ("Failed to deserialize column of type
    // 'void'"); casting makes the result a plain nullable text column.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${bookLockKey(bookGuid)}))::text AS locked`;
}

/**
 * Non-blocking transaction-scoped lock on a book. Returns false when another
 * operation currently holds the book lock — callers should surface a 409
 * ("another operation on this book is in progress") instead of queueing.
 */
export async function tryAcquireBookLock(
    tx: MaybeRawClient,
    bookGuid: string,
): Promise<boolean> {
    if (typeof tx.$queryRaw !== 'function') return true; // test double — no raw support
    const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext(${bookLockKey(bookGuid)})) AS locked
    `;
    return rows?.[0]?.locked === true;
}

/**
 * Blocking transaction-scoped lock on an arbitrary named resource, e.g.
 * `commodity:CURRENCY:USD` or `account:<parentGuid>:<name>`. Used to make
 * check-then-insert patterns safe until unique indexes land (Phase 3).
 *
 * Returns true when the lock was actually taken (raw-capable client) so
 * callers know whether a post-lock re-check is meaningful.
 */
export async function acquireNamedXactLock(
    tx: MaybeRawClient,
    key: string,
): Promise<boolean> {
    if (typeof tx.$queryRaw !== 'function') return false; // test double — no raw support
    // ::text cast — see acquireBookLock: void columns break $queryRaw.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text AS locked`;
    return true;
}

/** Lock key guarding find-or-create of a commodity by natural key. */
export function commodityLockKey(namespace: string, mnemonic: string): string {
    return `commodity:${namespace}:${mnemonic}`;
}

/** Lock key guarding find-or-create of an account by (parent, name). */
export function accountNameLockKey(parentGuid: string, name: string): string {
    return `account:${parentGuid}:${name}`;
}

/**
 * Resolve the advisory-lock key for the book containing an account: walks the
 * parent chain to the tree root, then finds the owning book. Falls back to
 * the root account guid when no book row references the root (orphan trees),
 * which still yields a consistent key for all accounts in the same tree.
 *
 * The walk is bounded and cycle-safe so it terminates even on an already
 * corrupted (cyclic) tree.
 */
export async function resolveBookLockGuidForAccount(
    accountGuid: string,
): Promise<string> {
    const { default: prisma } = await import('./prisma');
    // Depth-bounded upward walk (terminates even on an already-cyclic tree).
    const roots = await prisma.$queryRaw<Array<{ guid: string }>>`
        WITH RECURSIVE up AS (
            SELECT guid, parent_guid, 1 AS depth
            FROM accounts WHERE guid = ${accountGuid}
            UNION ALL
            SELECT a.guid, a.parent_guid, up.depth + 1
            FROM accounts a
            JOIN up ON a.guid = up.parent_guid
            WHERE up.depth < 200
        )
        SELECT guid FROM up ORDER BY depth DESC LIMIT 1
    `;
    const rootGuid = roots[0]?.guid ?? accountGuid;
    const book = await prisma.books.findFirst({
        where: {
            OR: [{ root_account_guid: rootGuid }, { root_template_guid: rootGuid }],
        },
        select: { guid: true },
    });
    return book?.guid ?? rootGuid;
}
