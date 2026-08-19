/**
 * Reconciled-Split Guard
 *
 * A split whose `reconcile_state` is 'y' (reconciled) or 'f' (frozen) has been
 * agreed against an external statement. Silently rewriting or deleting one
 * desynchronizes the book from that statement, so every ledger-mutating path
 * must refuse the write instead:
 *
 *   - changing a split's value/quantity (amount)
 *   - changing the account a split posts to
 *   - changing the parent transaction's post date
 *   - deleting a split
 *   - deleting the parent transaction
 *
 * This module is the single enforcement point. Callers use one of three
 * layers, cheapest first:
 *
 *   assertSplitsNotProtected()      pure — rows already in hand (no extra query)
 *   assertNoReconciledSplits()      async — locks the parents, then looks up
 *   withReconciledSplitCheck()      API routes — returns a ready NextResponse
 *
 * ## Locking: why a Prisma transaction alone is NOT enough
 *
 * Reading the splits inside `prisma.$transaction` does not make the check
 * authoritative. Postgres' default READ COMMITTED isolation takes no locks on
 * a plain SELECT, so this interleaving loses:
 *
 *     writer A: read splits → sees 'n'
 *     writer B: UPDATE splits SET reconcile_state='y' … COMMIT
 *     writer A: guard passes on the stale read → rewrites a reconciled split
 *
 * The codebase's canonical fix, already used by every split-writing path, is
 * to take a `SELECT … FROM transactions … ORDER BY guid FOR UPDATE` on the
 * parent transaction rows FIRST, then read and write the splits. Ordering by
 * guid keeps concurrent writers from ABBA-deadlocking. Every reconcile-state
 * writer takes that same parent lock, so once we hold it no reconcile can
 * commit between our read and our write.
 *
 * `assertNoReconciledSplits` therefore takes the parent lock itself — callers
 * get a race-free check by construction. `assertSplitsNotProtected` is pure
 * and cannot lock: callers of THAT overload must already hold the parent
 * transaction lock (each call site documents where it was taken).
 *
 * Belt and braces: bulk `updateMany` paths additionally push
 * `reconcile_state NOT IN ('y','f')` into their own WHERE clause, so even a
 * future caller that forgets the lock cannot write a protected row.
 *
 * The escape hatch is deliberate and preserved: the reconcile routes
 * (`PATCH|POST /api/splits/[guid]/reconcile`, `POST /api/splits/bulk/reconcile`)
 * set `reconcile_state` back to 'n' — and accept 'n' for a currently-frozen
 * ('f') split too, so 'f' is recoverable, not a dead end. Those routes
 * intentionally do NOT call this guard: they are the way out.
 *
 * HTTP status is 423 Locked, not 409. The transaction routes already use 409
 * for the optimistic-concurrency conflict and their clients special-case it:
 * `AccountLedger.tsx` silently reloads and returns (the block would vanish
 * entirely), and `TransactionFormModal.tsx` reloads and then throws a fixed
 * "changed by someone else" message (the block would be shown, but with the
 * wrong reason and no mention of unreconciling). 423 falls through to both
 * components' generic error surface, which renders this module's message.
 */

import { NextResponse } from 'next/server';
import type { DbClient } from '@/lib/scheduled-transactions';

/** Reconcile states that pin a split to an external statement. */
export const PROTECTED_RECONCILE_STATES = ['y', 'f'] as const;
export type ProtectedReconcileState = (typeof PROTECTED_RECONCILE_STATES)[number];

const STATE_LABEL: Record<ProtectedReconcileState, string> = {
    y: 'reconciled',
    f: 'frozen',
};

/** How many offending splits are named before the message is elided. */
const MAX_NAMED_SPLITS = 5;

/**
 * The subset of a split row this guard reads. Deliberately loose so callers
 * can hand over rows they already fetched for other reasons (the transaction
 * PUT/DELETE routes, bulk move, bulk edit) instead of paying for a second
 * query.
 */
export interface SplitReconcileRow {
    guid: string;
    tx_guid?: string | null;
    account_guid?: string | null;
    reconcile_state?: string | null;
    account?: { name?: string | null } | null;
}

/** A split the guard refuses to let the caller touch. */
export interface ProtectedSplitRef {
    splitGuid: string;
    txGuid: string | null;
    accountGuid: string | null;
    accountName: string | null;
    reconcileState: ProtectedReconcileState;
}

/** True when the state pins the split to a statement ('y' or 'f'). */
export function isProtectedReconcileState(
    state: string | null | undefined,
): state is ProtectedReconcileState {
    return state === 'y' || state === 'f';
}

/** Pick the reconciled/frozen rows out of a split list. Pure. */
export function findProtectedSplits(
    rows: readonly SplitReconcileRow[],
): ProtectedSplitRef[] {
    const protectedRefs: ProtectedSplitRef[] = [];
    for (const row of rows) {
        if (!isProtectedReconcileState(row.reconcile_state)) continue;
        protectedRefs.push({
            splitGuid: row.guid,
            txGuid: row.tx_guid ?? null,
            accountGuid: row.account_guid ?? null,
            accountName: row.account?.name ?? null,
            reconcileState: row.reconcile_state,
        });
    }
    return protectedRefs;
}

/** Human-readable list naming the offending splits (elided past 5). */
export function describeProtectedSplits(refs: readonly ProtectedSplitRef[]): string {
    const named = refs.slice(0, MAX_NAMED_SPLITS).map(ref => {
        const where = ref.accountName ?? ref.accountGuid;
        const on = where ? ` on ${where}` : '';
        const inTx = ref.txGuid ? ` (transaction ${ref.txGuid})` : '';
        return `split ${ref.splitGuid}${on} is ${STATE_LABEL[ref.reconcileState]}`
            + ` (reconcile_state '${ref.reconcileState}')${inTx}`;
    });
    const rest = refs.length - named.length;
    if (rest > 0) named.push(`and ${rest} more`);
    return named.join('; ');
}

/**
 * The full user-facing message: what was refused, which split blocked it, and
 * the exact way out.
 */
export function reconciledSplitMessage(
    operation: string,
    refs: readonly ProtectedSplitRef[],
): string {
    return `Cannot ${operation}: ${describeProtectedSplits(refs)}.`
        + ' Unreconcile the split first (set its reconcile state back to "n"'
        + ' via /api/splits/{guid}/reconcile), then retry.';
}

/**
 * Thrown by the service-layer guards. API routes map it to a 423 via
 * `reconciledSplitResponse`.
 */
export class ReconciledSplitError extends Error {
    readonly code = 'RECONCILED_SPLIT';
    /** Every split that blocked the write, so callers can report all of them. */
    readonly splits: ProtectedSplitRef[];

    constructor(operation: string, splits: ProtectedSplitRef[]) {
        super(reconciledSplitMessage(operation, splits));
        this.name = 'ReconciledSplitError';
        this.splits = splits;
    }
}

/**
 * Throw when any of the supplied rows is reconciled or frozen. Pure.
 *
 * PRECONDITION: the caller must already hold the `FOR UPDATE` lock on the
 * parent transaction rows of every split passed in, and must have read those
 * splits AFTER taking it — otherwise a concurrent reconcile can commit
 * between the read and the write and this check is decorative. Use
 * `lockTransactionsForUpdate` (or an existing parent-row lock) first, or call
 * `assertNoReconciledSplits`, which does both for you.
 *
 * @param operation gerund-free verb phrase, e.g. 'delete this transaction'
 */
export function assertSplitsNotProtected(
    operation: string,
    rows: readonly SplitReconcileRow[],
): void {
    const refs = findProtectedSplits(rows);
    if (refs.length > 0) throw new ReconciledSplitError(operation, refs);
}

export interface ReconciledCheckOptions {
    /**
     * The client of the database transaction performing the write. REQUIRED:
     * the guard's `FOR UPDATE` must be held until that write commits, and the
     * read must see that transaction's snapshot. Passing the global client
     * would take a second pool connection, read outside the transaction, and
     * release the lock the instant the locking statement returned.
     */
    client: DbClient;
    /**
     * The account guids of the CALLER'S BOOK (`getAccountGuidsForBook` /
     * `getBookAccountGuids`). REQUIRED, and not a performance hint.
     *
     * Split and transaction guids arrive from the client, so without a book
     * predicate the guard reads — and locks — rows the caller has no business
     * touching. Two concrete leaks:
     *
     *   - the 423 message names the offending split's ACCOUNT, so an
     *     out-of-book guid would hand the caller the name of an account in
     *     someone else's book (a cross-tenant information disclosure through
     *     an error string);
     *   - the `FOR UPDATE` would take row locks on another book's
     *     transactions, letting one tenant stall another's writes.
     *
     * Every guid is filtered through this set before it is locked or read, so
     * an out-of-book guid is simply invisible to the guard: it is neither
     * locked nor named. The caller's own book-scoped WHERE clause is what
     * refuses the write itself.
     */
    bookAccountGuids: readonly string[];
}

/**
 * Normalize the caller's book scope, refusing an empty one.
 *
 * A book always has at least its root account, so an empty list means the
 * caller resolved a book that does not exist — continuing would silently
 * degrade the guard to "nothing is in scope, so nothing is protected".
 */
function requireBookScope(bookAccountGuids: readonly string[]): string[] {
    if (bookAccountGuids.length === 0) {
        throw new Error(
            'Reconciled-split guard requires a non-empty book account scope;'
            + ' resolve it with getAccountGuidsForBook()/getBookAccountGuids().',
        );
    }
    return [...bookAccountGuids];
}

/**
 * Take the canonical `FOR UPDATE` lock on a set of parent transaction rows,
 * ordered by guid so concurrent writers cannot ABBA-deadlock. This is the
 * same lock (and the same ordering) every split-writing path in the codebase
 * takes before touching splits — including the reconcile routes, which is
 * what makes holding it sufficient to freeze `reconcile_state`.
 *
 * Call inside a database transaction, passing that transaction's client.
 *
 * `bookAccountGuids` restricts the lock to transactions that actually post to
 * the caller's book, so a guid from another book takes no row lock. It is
 * optional here only because several callers (bulk move, bulk reconcile,
 * lot assignment) have already proven book membership of the very rows they
 * are about to lock; `assertNoReconciledSplits`, whose guids come straight
 * from the request, always passes it.
 */
export async function lockTransactionsForUpdate(
    txGuids: readonly string[],
    client: DbClient,
    bookAccountGuids?: readonly string[],
): Promise<void> {
    const ordered = [...new Set(txGuids)].sort();
    if (ordered.length === 0) return;
    if (bookAccountGuids) {
        const book = [...bookAccountGuids];
        await client.$queryRaw`
            SELECT t.guid FROM transactions t
            WHERE t.guid = ANY(${ordered}::text[])
              AND EXISTS (
                  SELECT 1 FROM splits s
                  WHERE s.tx_guid = t.guid
                    AND s.account_guid = ANY(${book}::text[])
              )
            ORDER BY t.guid
            FOR UPDATE
        `;
        return;
    }
    await client.$queryRaw`
        SELECT guid FROM transactions
        WHERE guid = ANY(${ordered}::text[])
        ORDER BY guid
        FOR UPDATE
    `;
}

/**
 * Lock the parent transactions of a set of splits, addressed by SPLIT guid.
 *
 * Resolution and locking happen in ONE statement. Doing it as two (read the
 * tx_guids, then lock them) would be defensible — a split's tx_guid is
 * immutable — but "the lock is taken before anything is read" is a property
 * worth being able to state without a caveat, so the subquery resolves inside
 * the locking statement itself. Rows are still ordered by guid.
 *
 * `bookAccountGuids`, when supplied, is pushed into the resolving subquery so
 * a split guid belonging to another book resolves to no parent at all and
 * takes no lock.
 */
export async function lockTransactionsForSplits(
    splitGuids: readonly string[],
    client: DbClient,
    bookAccountGuids?: readonly string[],
): Promise<void> {
    const ordered = [...new Set(splitGuids)].sort();
    if (ordered.length === 0) return;
    if (bookAccountGuids) {
        const book = [...bookAccountGuids];
        await client.$queryRaw`
            SELECT t.guid FROM transactions t
            WHERE t.guid IN (
                SELECT s.tx_guid FROM splits s
                WHERE s.guid = ANY(${ordered}::text[])
                  AND s.account_guid = ANY(${book}::text[])
            )
            ORDER BY t.guid
            FOR UPDATE
        `;
        return;
    }
    await client.$queryRaw`
        SELECT t.guid FROM transactions t
        WHERE t.guid IN (
            SELECT s.tx_guid FROM splits s WHERE s.guid = ANY(${ordered}::text[])
        )
        ORDER BY t.guid
        FOR UPDATE
    `;
}

/**
 * Look up the splits the mutation would touch and throw when any is
 * reconciled or frozen. Pass `txGuids` to cover whole transactions
 * (edit/delete of a transaction), `splitGuids` to cover individual splits
 * (move/recategorize), or both.
 *
 * Race-free by construction: the parent transaction rows are locked
 * `FOR UPDATE` (guid order) BEFORE the splits are read, so a concurrent
 * reconcile cannot commit between this check and the caller's write.
 *
 * `client` is REQUIRED, and must be the client of the database transaction
 * that performs the write. Without it the `FOR UPDATE` would run as its own
 * implicit transaction and release the moment that statement returned —
 * leaving a function documented as race-free that is not. Making the
 * parameter optional invited exactly the regression this guard exists to
 * prevent, so the unsafe mode does not exist.
 *
 * `bookAccountGuids` is REQUIRED for the same reason: the guids come from the
 * request, so every lock and every read is constrained to the caller's book.
 * An out-of-book guid is neither locked nor named in the error.
 */
export async function assertNoReconciledSplits(
    operation: string,
    target: { txGuids?: readonly string[]; splitGuids?: readonly string[] },
    options: ReconciledCheckOptions,
): Promise<void> {
    const txGuids = target.txGuids ?? [];
    const splitGuids = target.splitGuids ?? [];
    const book = requireBookScope(options.bookAccountGuids);
    if (txGuids.length === 0 && splitGuids.length === 0) return;

    const db = options.client;

    // Lock first, in both address spaces. Each is a single statement that
    // resolves, book-scopes, and locks together.
    await lockTransactionsForUpdate(txGuids, db, book);
    await lockTransactionsForSplits(splitGuids, db, book);

    // Read AFTER the lock: anything committed before it is visible, and
    // nothing new can commit while we hold it.
    const or: { tx_guid?: { in: string[] }; guid?: { in: string[] } }[] = [];
    if (txGuids.length > 0) or.push({ tx_guid: { in: [...txGuids] } });
    if (splitGuids.length > 0) or.push({ guid: { in: [...splitGuids] } });

    const rows = await db.splits.findMany({
        where: {
            OR: or,
            // Book scope. Without it the message below could name an account
            // from another book.
            account_guid: { in: book },
            reconcile_state: { in: [...PROTECTED_RECONCILE_STATES] },
        },
        select: {
            guid: true,
            tx_guid: true,
            account_guid: true,
            reconcile_state: true,
            account: { select: { name: true } },
        },
    });

    assertSplitsNotProtected(operation, rows);
}

// ---------------------------------------------------------------------------
// API-route helpers
// ---------------------------------------------------------------------------

/** The standard reconciled-split payload (423 Locked). */
export function reconciledSplitResponse(error: ReconciledSplitError): NextResponse {
    return NextResponse.json(
        {
            error: error.message,
            code: error.code,
            splits: error.splits.map(ref => ({
                guid: ref.splitGuid,
                tx_guid: ref.txGuid,
                account_guid: ref.accountGuid,
                reconcile_state: ref.reconcileState,
            })),
        },
        { status: 423 },
    );
}

/**
 * Route-level guard: returns the ready-to-send 423 RECONCILED_SPLIT response,
 * or null when the mutation may proceed. Same contract as
 * `assertNoReconciledSplits` — the write transaction's client and the
 * caller's book scope are both required.
 *
 *     const blocked = await withReconciledSplitCheck(
 *         'edit this transaction', { txGuids: [guid] },
 *         { client: tx, bookAccountGuids: await getBookAccountGuids() });
 *     if (blocked) return blocked;
 */
export async function withReconciledSplitCheck(
    operation: string,
    target: { txGuids?: readonly string[]; splitGuids?: readonly string[] },
    options: ReconciledCheckOptions,
): Promise<NextResponse | null> {
    try {
        await assertNoReconciledSplits(operation, target, options);
        return null;
    } catch (err) {
        if (err instanceof ReconciledSplitError) return reconciledSplitResponse(err);
        throw err;
    }
}
