/**
 * The canonical acquisition order for account sibling-name locks, and the
 * RUNTIME invariant that enforces it.
 *
 * ## Why this module exists
 *
 * `accountNameLockKey` (src/lib/book-lock.ts) states two rules. Until this
 * module both were enforced only by prose and by a source-text scan
 * (src/lib/__tests__/account-name-lock-ordering-source.test.ts), which compares
 * BYTE OFFSETS in a file. That scan cannot see indirection — a row write moved
 * into a helper defined above the claim keeps the offsets in order while
 * executing the forbidden sequence — and it says nothing at all about the
 * order two name locks are taken in.
 *
 * Both rules are properties of an EXECUTION, so they are checked here against
 * the execution:
 *
 *   RULE 1 (ordering between two name locks). Within one transaction, every
 *     name lock must be acquired at a position >= the greatest one already
 *     held, under the total order defined by {@link compareLockOrder}. Two
 *     transactions that each acquire a subsequence of one global total order
 *     cannot close a wait-for cycle, which is the whole argument.
 *
 *   RULE 2 (level 2 before level 3). A transaction must not ACQUIRE a row
 *     lock on an account row while it holds a name lock. `AccountService`
 *     `.update`/`.move` take the row lock FIRST and the name key second, so a
 *     holder that reversed those two closes a wait-for cycle against them.
 *     Two halves enforce it: {@link noteAccountRowLocked}, called from the
 *     `SELECT ... FOR UPDATE` itself, throws if a name lock is already held;
 *     and a Prisma extension in src/lib/prisma.ts refuses any `accounts`
 *     UPDATE/DELETE under a name lock unless the transaction had already
 *     INSERTed or row-locked exactly the rows it targets. The second half is
 *     what catches the write that reaches a row WITHOUT going through
 *     `lockAccountKey` — an implicit row lock nobody declared.
 *
 * ## The total order
 *
 * A name lock guards a node of the account tree, so the order is the node's
 * position in that tree: its BOOK-ROOT-RELATIVE PATH, compared segment by
 * segment, with the book root guid as the leading discriminator.
 *
 * That order has the two properties it needs. It is derivable by every
 * participant without coordination — two transactions contending for a key
 * necessarily agree on the path to it — and it places an ancestor before its
 * descendants, which is the order a path walk takes them in anyway. So a
 * caller that walks paths downward and visits siblings in sorted order is
 * compliant by construction; that is exactly what the multi-key holders now
 * do (see the callers of {@link sortByLockOrder}).
 *
 * ## Every holder
 *
 * Exhaustive as of this change, transitive holders included — the three that
 * hid last round all reached a claim through `findOrCreateAccount`, so the
 * find-or-create callers are listed as holders in their own right. For each:
 * its key set, whether that set is knowable before the first claim, and which
 * strategy it uses.
 *
 * MULTI-KEY, key set knowable up front -> SORT ({@link sortByLockOrder}):
 *
 *   1. trading-accounts.ts:217,270,308, reached from processMultiCurrencySplits
 *      (trading-accounts.ts:511). Keys: Trading, Trading:<ns>, and
 *      Trading:<ns>:<mnemonic> per imbalanced commodity. Knowable —
 *      `calculateImbalances` returns the whole set. It was claimed in SPLIT
 *      ENCOUNTER ORDER, which is BLOCKER 2: a USD->EUR save and a EUR->USD
 *      save took the two leaf keys in opposite orders. Now sorted first.
 *   2. default-book.ts:353 (`addTemplateAccounts`). Keys: the missing subtree
 *      roots of a template graft. Knowable — phase 2 collects them all before
 *      phase 3 claims any. Sorted by root-relative path.
 *   3. inventory-engine.ts:923 (`bootstrapInventoryAccounts`). Keys: the
 *      missing book-root children of a fixed spec list. Knowable. Sorted.
 *   4. import/settlement-import.service.ts:552, claiming through
 *      `findOrCreateAccountDetailed`. Keys: one path per USED settlement role.
 *      Knowable — the role set is resolved before any account work. Sorted by
 *      path, not by the order the roles happen to be written in.
 *
 * MULTI-KEY, key set NOT knowable up front -> BOOK LOCK (`acquireBookLock`),
 * following the precedent the XML importer already set. Both also sort what
 * they do know, so the ordering invariant holds on its own terms rather than
 * only because the book lock hid the question:
 *
 *   5. qif/importer.ts:722 (`executeQifImport`), claiming through
 *      `findOrCreateAccountDetailed` at qif/importer.ts:666. Keys: whatever
 *      tree the uploaded file describes, in the order its author typed it.
 *      BLOCKER 1.
 *   6. import/personal-import.service.ts:498, claiming through
 *      `findOrCreateAccountDetailed` at :421. Same shape, same fix.
 *
 * MULTI-KEY, ordered BY CONSTRUCTION — a path walk claims a strictly growing
 * prefix, which is already ascending in this order, so there is nothing to
 * sort:
 *
 *   7. gnucash.ts:318, the walk inside `findOrCreateAccountWithin` itself.
 *   8. services/packages.service.ts:210 (`ensureTypedAccount`), reached from
 *      :478 and :575 — two SEPARATE transactions, one walk each.
 *   9. reconcile.ts:394 — one `Imbalance-<CUR>` path per adjustment.
 *  10. business/bill-capture.ts:306 — one fixed expense path.
 *
 * SINGLE KEY -> {@link acquireSoleAccountNameLock}, which refuses a second
 * claim so that "only one" cannot quietly stop being true:
 *
 *  11. services/account.service.ts:92 (`claimSiblingName`, for `.create`,
 *      `.update` and `.move`). This is also the level-2/level-3 holder:
 *      `.update` and `.move` take the row lock FIRST and the name key second.
 *  12. services/simplefin-sync.service.ts:1583 (imbalance), :1695 (per-symbol
 *      child), :1841 (cash child) — three separate transactions, one key each.
 *  13. services/demo-book.service.ts:157 — one key per transaction, in a loop
 *      of separate transactions.
 *  14. business/invoice-engine.ts:767 (`findOrCreatePostAccount`). One A/R–A/P
 *      name at the book root. It passes a path rather than making a sole claim
 *      because it runs inside the larger `postInvoice` transaction.
 *
 * NOT ORDERED — said plainly rather than narrowed away:
 *
 *  15. lot-scrub.ts:1871 (`generateCapitalGains`). See
 *      {@link UNORDERED_CLAIM_SITES} for why neither strategy fits, what does
 *      hold it shut today, and exactly what residual exposure remains.
 *
 * ## Sole claims
 *
 * Most holders take exactly ONE contended key per transaction and have no
 * root-relative path handy (`AccountService.create` is given a parent guid and
 * a name, nothing more). Ordering cannot bind a single lock, so those callers
 * use {@link acquireSoleAccountNameLock}, which registers the claim and then
 * refuses any SECOND account name lock in the same transaction. The escape
 * hatch is therefore self-limiting: a caller cannot quietly grow into a
 * multi-key holder without either supplying a path or failing loudly.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
    accountNameLockKey,
    acquireAccountKeyLockUnchecked,
    type MaybeRawClient,
} from './book-lock';

/**
 * A node's position in the account tree: the book root it hangs off, and the
 * path of names from that root down to and including the locked name.
 */
export interface AccountLockOrder {
    bookRootGuid: string;
    /** Root-relative names, ending with the name this lock guards. */
    path: readonly string[];
}

/** Thrown when a transaction breaks the acquisition order. See RULE 1. */
export class AccountLockOrderError extends Error {
    readonly code = 'ACCOUNT_LOCK_ORDER';
    constructor(message: string) {
        super(message);
        this.name = 'AccountLockOrderError';
    }
}

/** Thrown when a transaction writes an account row it does not own. RULE 2. */
export class AccountRowWriteUnderNameLockError extends Error {
    readonly code = 'ACCOUNT_ROW_WRITE_UNDER_NAME_LOCK';
    constructor(message: string) {
        super(message);
        this.name = 'AccountRowWriteUnderNameLockError';
    }
}

interface HeldLock {
    key: string;
    /** null for a sole claim — see the "Sole claims" section above. */
    order: AccountLockOrder | null;
}

/** Everything the invariant knows about one in-flight transaction. */
export interface AccountLockScope {
    held: HeldLock[];
    /** Guids of account rows INSERTed by this transaction. RULE 2's exemption. */
    inserted: Set<string>;
    /**
     * Guids this transaction row-locked BEFORE it held any name lock, and may
     * therefore still write. RULE 2's other exemption: the lock was taken at
     * level 2, in the canonical order, so writing the row it already owns
     * cannot reverse anything.
     */
    rowLocked: Set<string>;
}

function newScope(): AccountLockScope {
    return { held: [], inserted: new Set(), rowLocked: new Set() };
}

/**
 * The scope of the transaction currently executing.
 *
 * Entered once, in src/lib/prisma.ts, by the `$transaction` wrapper — so every
 * `prisma.$transaction(...)` in the repository gets one without its author
 * having to know this module exists. AsyncLocalStorage propagates through the
 * whole await tree of the callback, which is what lets a Prisma query
 * extension several layers down read the same scope.
 */
const scopeStorage = new AsyncLocalStorage<AccountLockScope>();

/** Runs `fn` with a fresh transaction scope. Called only from prisma.ts. */
export function withAccountLockScope<T>(fn: () => Promise<T>): Promise<T> {
    return scopeStorage.run(newScope(), fn);
}

/** The scope of the transaction in flight, or null outside one. */
export function currentAccountLockScope(): AccountLockScope | null {
    return scopeStorage.getStore() ?? null;
}

/**
 * The scope a claim is recorded against.
 *
 * Deliberately ALS-only, with no per-client fallback. Every production
 * transaction reaches this through the wrapped `$transaction`, so the ambient
 * scope is always the right one. A fallback keyed on the client OBJECT looked
 * equivalent and is not: unit tests reuse one fake client across several
 * logically separate `findOrCreateAccount` calls, and a WeakMap on that object
 * merges them into one apparent transaction and reports ordering violations
 * that no real transaction could commit. Tracking nothing outside a real
 * transaction is the honest behaviour, and is pinned by "tracks nothing
 * outside a transaction rather than inventing a scope" in
 * src/lib/__tests__/account-lock-order.test.ts.
 */
function currentScope(): AccountLockScope {
    return scopeStorage.getStore() ?? newScope();
}

/**
 * Sites that claim sibling keys in an order this module cannot yet check,
 * with what it would take to fix each. A registered site LOGS its violation
 * instead of throwing.
 *
 * This list is not an escape hatch for new code — nothing outside it may skip
 * the order, `acquireAccountNameLock` rejects an unregistered id, and
 * src/lib/__tests__/account-lock-order.test.ts pins the list so it cannot grow
 * without a deliberate edit. It exists so the invariant can ship enforcing
 * everything it CAN enforce today, rather than being weakened everywhere to
 * accommodate one holder.
 */
export const UNORDERED_CLAIM_SITES: Record<string, string> = {
    'lot-scrub:capital-gains':
        'generateCapitalGains (src/lib/lot-scrub.ts:1871) creates Income:Capital Gains:{Long,Short} Term ' +
        'for each lot a scrub closes, in lot order. The two leaves are siblings, so a scrub that closes ' +
        'a short-term lot before a long-term one claims them backwards. ' +
        'NEITHER STRATEGY APPLIES CLEANLY. Sorting needs the key set up front, and the key set is the ' +
        'per-lot holding period, which generateCapitalGains only settles halfway through its own work ' +
        '(after transfer-vs-sale classification and basis tracing, both of which cost per-split queries); ' +
        'hoisting that into a pre-pass is a refactor of the scrub engine, not of this claim. ' +
        'WHAT ACTUALLY HOLDS IT SHUT is the second strategy, applied one level up: both entry points ' +
        'that reach this code serialize on the per-book key before any lot work starts — autoAssignLots ' +
        '(src/lib/lot-assignment.ts:662) via tryAcquireBookLock, and scrubAllAccounts ' +
        '(src/lib/lot-assignment.ts:1109) via a SESSION-level lock on the same bookLockKey held for the ' +
        'whole run. Both are TRY acquisitions that fail fast with BookBusyError (HTTP 409) rather than ' +
        'waiting, so they cannot themselves join a wait-for cycle, and no two gains-creating runs against ' +
        'one book overlap. Different books use different parent guids, hence different keys. ' +
        'THE RESIDUAL, stated rather than argued away: that reasoning excludes another SCRUB. It does not ' +
        'by itself exclude some future non-book-locked holder that claims BOTH capital-gains leaves in ' +
        'sorted order; against that this site would still be the backwards half of an ABBA pair. No such ' +
        'holder exists today — every other multi-key holder is listed in the enumeration below — and ' +
        'scrub-all takes its book lock on a SEPARATE CONNECTION, so a transaction-scoped invariant cannot ' +
        'observe it and cannot be taught to accept it. Hence a logged violation rather than a silent pass.',
};

/**
 * The total order on tree nodes. Negative when `a` must be locked first.
 *
 * A path that is a proper prefix of another sorts FIRST, which is what puts an
 * ancestor ahead of its descendants.
 */
export function compareLockOrder(a: AccountLockOrder, b: AccountLockOrder): number {
    if (a.bookRootGuid !== b.bookRootGuid) {
        return a.bookRootGuid < b.bookRootGuid ? -1 : 1;
    }
    const shared = Math.min(a.path.length, b.path.length);
    for (let i = 0; i < shared; i++) {
        if (a.path[i] !== b.path[i]) return a.path[i] < b.path[i] ? -1 : 1;
    }
    return a.path.length - b.path.length;
}

/**
 * Sorts anything carrying an {@link AccountLockOrder} into the canonical
 * acquisition order. Every caller that knows its whole key set up front runs
 * its collection through this before it starts claiming.
 */
export function sortByLockOrder<T>(
    items: readonly T[],
    orderOf: (item: T) => AccountLockOrder,
): T[] {
    return [...items].sort((a, b) => compareLockOrder(orderOf(a), orderOf(b)));
}

function describe(order: AccountLockOrder): string {
    return `${order.path.join(':')} (book root ${order.bookRootGuid})`;
}

/**
 * Claims `account:(parentGuid, name)` in canonical order.
 *
 * `order.path` must be the book-root-relative path of the account being
 * claimed — its last segment is `name`. Throws {@link AccountLockOrderError}
 * when the claim would run backwards past a key this transaction already
 * holds, which is a latent ABBA deadlock against any transaction that takes
 * the same two keys the other way round.
 *
 * Returns whatever {@link acquireNamedXactLock} returned: false for an
 * in-memory test double that cannot lock at all.
 */
export async function acquireAccountNameLock(
    tx: MaybeRawClient,
    parentGuid: string,
    name: string,
    order: AccountLockOrder,
    unorderedSite?: string,
): Promise<boolean> {
    if (unorderedSite !== undefined && !(unorderedSite in UNORDERED_CLAIM_SITES)) {
        throw new AccountLockOrderError(
            `Unknown unordered-claim site "${unorderedSite}". Ordering may only be waived for a site ` +
            'registered in UNORDERED_CLAIM_SITES with the reason it is not yet fixed.',
        );
    }
    if (order.path[order.path.length - 1] !== name) {
        throw new AccountLockOrderError(
            `Lock order path ${describe(order)} does not end in the locked name "${name}". ` +
            'The path orders the claim, so a path that does not describe the claimed node orders nothing.',
        );
    }
    const key = accountNameLockKey(parentGuid, name);
    const scope = currentScope();

    // Re-entrant: this transaction already holds the key, so re-taking it
    // adds no wait-for edge and cannot be part of any cycle — whatever else
    // is held, and whatever order it was taken in. Checked BEFORE the loop
    // rather than skipped inside it: a `continue` compares the re-claim
    // against the OTHER keys held and rejects a walk that legitimately
    // revisits a shallow segment after a deeper one.
    if (scope.held.some(heldLock => heldLock.key === key)) {
        return acquireAccountKeyLockUnchecked(tx, key);
    }

    for (const heldLock of scope.held) {
        if (heldLock.order === null) {
            throw new AccountLockOrderError(
                `This transaction already claimed ${heldLock.key} as a SOLE account name lock and is now ` +
                `claiming ${key}. A sole claim carries no position in the acquisition order, so a second ` +
                'lock beside it cannot be ordered against it. Give both claims a root-relative path via ' +
                'acquireAccountNameLock instead.',
            );
        }
        if (compareLockOrder(order, heldLock.order) < 0) {
            const violation = new AccountLockOrderError(
                `Out-of-order account name lock: claiming ${describe(order)} while already holding ` +
                `${describe(heldLock.order)}, which sorts AFTER it. Advisory locks are held to COMMIT, so a ` +
                'concurrent transaction taking these two keys in the canonical order deadlocks against this ' +
                'one (SQLSTATE 40P01). Sort the whole key set with sortByLockOrder before claiming any of it.',
            );
            if (unorderedSite === undefined) throw violation;
            console.error(
                `[account-lock-order] known-unordered site "${unorderedSite}": ${violation.message}\n` +
                `  ${UNORDERED_CLAIM_SITES[unorderedSite]}`,
            );
        }
    }

    const locked = await acquireAccountKeyLockUnchecked(tx, key);
    scope.held.push({ key, order });
    return locked;
}

/**
 * Claims `account:(parentGuid, name)` as this transaction's ONLY account name
 * lock, for callers that have no root-relative path to order by.
 *
 * A single lock cannot be part of a cycle, so no order is needed — but that
 * argument dies the moment a second key is claimed, and so does this call:
 * a subsequent claim of any different account name lock in the same
 * transaction throws {@link AccountLockOrderError}.
 */
export async function acquireSoleAccountNameLock(
    tx: MaybeRawClient,
    parentGuid: string,
    name: string,
): Promise<boolean> {
    const key = accountNameLockKey(parentGuid, name);
    const scope = currentScope();

    // Re-entrant, exactly as in acquireAccountNameLock above.
    if (scope.held.some(heldLock => heldLock.key === key)) {
        return acquireAccountKeyLockUnchecked(tx, key);
    }

    if (scope.held.length > 0) {
        throw new AccountLockOrderError(
            `Sole account name lock ${key} claimed while this transaction already holds ` +
            `${scope.held.map(heldLock => heldLock.key).join(', ')}. A holder of more than one name key ` +
            'must order every claim by its root-relative path — see acquireAccountNameLock.',
        );
    }

    const locked = await acquireAccountKeyLockUnchecked(tx, key);
    scope.held.push({ key, order: null });
    return locked;
}

/** Records an account row this transaction INSERTed. RULE 2's exemption. */
export function noteAccountRowInserted(guid: string): void {
    scopeStorage.getStore()?.inserted.add(guid);
}

/**
 * Records a `SELECT ... FOR UPDATE` on an account row, and enforces the half
 * of RULE 2 that a Prisma extension cannot see.
 *
 * Called from `lockAccountKey` (src/lib/services/account.service.ts) at the
 * moment the row lock is taken. Throws when a name lock is ALREADY held,
 * because that is the reversal itself: `.update` and `.move` take the row lock
 * first and the name key second, so a transaction doing it the other way round
 * completes a wait-for cycle with them and one side dies with SQLSTATE 40P01.
 *
 * Having taken the lock in the right order, the transaction may go on to write
 * that row even after it later claims a name key — it already owns the row, so
 * nothing new is being waited on.
 */
export function noteAccountRowLocked(guid: string): void {
    const scope = scopeStorage.getStore();
    if (!scope) return;
    if (scope.held.length > 0) {
        throw new AccountRowWriteUnderNameLockError(
            `SELECT ... FOR UPDATE on accounts row ${guid} while holding account name lock(s) ` +
            `[${scope.held.map(heldLock => heldLock.key).join(', ')}]. AccountService.update/.move take ` +
            'the row lock FIRST and the name key second; taking them the other way round closes a ' +
            'wait-for cycle against those two (SQLSTATE 40P01). Row-lock everything this transaction ' +
            'needs before it claims its first sibling key.',
        );
    }
    scope.rowLocked.add(guid);
}

/** Guids named by a Prisma `where` this module can reason about, or null. */
export function guidsTargetedBy(where: unknown): string[] | null {
    if (typeof where !== 'object' || where === null) return null;
    const guid = (where as { guid?: unknown }).guid;
    if (typeof guid === 'string') return [guid];
    if (typeof guid === 'object' && guid !== null) {
        const list = (guid as { in?: unknown }).in;
        if (Array.isArray(list) && list.every(g => typeof g === 'string')) {
            return list as string[];
        }
    }
    return null;
}

/**
 * RULE 2. Throws when an `accounts` UPDATE/DELETE runs while this transaction
 * holds a name lock and does not provably target only rows it inserted.
 *
 * A `where` this function cannot resolve to a guid list is treated as a
 * violation rather than waved through: the point of the check is to catch the
 * write nobody thought about.
 */
export function assertAccountRowWriteAllowed(operation: string, where: unknown): void {
    const scope = scopeStorage.getStore();
    if (!scope || scope.held.length === 0) return;

    const targeted = guidsTargetedBy(where);
    if (targeted && targeted.every(g => scope.inserted.has(g) || scope.rowLocked.has(g))) return;

    const held = scope.held.map(heldLock => heldLock.key).join(', ');
    const target = targeted ? targeted.join(', ') : JSON.stringify(where ?? null);
    throw new AccountRowWriteUnderNameLockError(
        `accounts.${operation} on [${target}] while holding account name lock(s) [${held}]. ` +
        'Writing a row this transaction neither INSERTed nor row-locked beforehand takes an implicit ' +
        'row lock from underneath the name lock, which runs the hierarchy backwards against ' +
        'AccountService.update/.move — those lock the row FIRST, so the pair closes a wait-for cycle ' +
        '(SQLSTATE 40P01). Reconcile existing rows in a phase that holds no name lock, row-lock them ' +
        'before the first claim (see noteAccountRowLocked), or restrict the write to guids this ' +
        'transaction INSERTed.',
    );
}
