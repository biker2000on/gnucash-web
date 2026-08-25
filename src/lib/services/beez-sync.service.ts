/**
 * beez-trackz sync contract, v1 — the database half.
 *
 * The routes under src/app/api/integrations/beez/* are deliberately thin: they
 * authenticate, hand the parsed body to a function here, and translate a
 * {@link BeezSyncError} into a status code. Everything that touches the ledger
 * lives in this file so the round trip (write → replay → change feed) can be
 * exercised by the integration tier against a real PostgreSQL server without
 * standing up a Next.js request scope.
 *
 * Contracts this file is responsible for:
 *
 *  - **One ledger entry per external id.** Enforced by the UNIQUE index on
 *    (book_guid, source, external_id), never by a read-then-write. A replayed
 *    POST loses the race in the database and is answered from the existing
 *    link.
 *  - **One book.** Every account named by a caller must be inside the token's
 *    book. A missing account and a foreign account produce the SAME 404, so the
 *    API cannot be used as a cross-book existence oracle.
 *  - **Book root currency only.** v1 writes `amountCents/100`, which is a
 *    currency amount. Stock, multi-currency, and foreign-denominated accounts
 *    are refused rather than approximated.
 *  - **Reconciled work is not ours to move.** A split marked 'y' (reconciled) or
 *    'f' (frozen) is pinned to a bank statement; replacing or deleting it
 *    silently would break an agreement a human made. The rule lives in
 *    src/lib/services/reconciled-split.service.ts and this file defers to it —
 *    a second, narrower spelling of "protected" here is exactly how 'f' got
 *    missed once already.
 *  - **Evidence.** Every mutation writes an audit row (TODOS.md: "evidence is
 *    part of the result") and stamps `gnucash_web_transaction_meta` with
 *    source='beez-trackz'.
 */

import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import type { DbClient } from '@/lib/scheduled-transactions';
import { generateGuid } from '@/lib/gnucash';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { logAudit } from '@/lib/services/audit.service';
import { cacheInvalidateFrom } from '@/lib/cache';
import { publishDataChange } from '@/lib/data-events';
import { assertNotLocked } from '@/lib/services/period-lock.service';
import {
    assertSplitsNotProtected,
    ReconciledSplitError,
} from '@/lib/services/reconciled-split.service';
import {
    claimWebhookIdempotency,
    completeWebhookIdempotency,
    lockWebhookIdempotencyAttempt,
    releaseWebhookIdempotency,
    WebhookClaimSupersededError,
    type WebhookEndpoint,
} from '@/lib/webhook-idempotency';
import {
    BEEZ_META_SOURCE,
    BEEZ_SOURCE,
    CENTS_DENOM,
    ENTER_DATE_PG_FORMAT,
    decodeChangesCursor,
    encodeChangesCursor,
    postDateToTimestamp,
    splitValueToCents,
    timestampToPostDate,
    type BeezTransactionInput,
    type ChangesCursor,
} from '@/lib/integrations/beez';

/**
 * A refusal with the status and machine-readable code the wire contract names.
 * `code` becomes the response body's `error`; `detail` is the sentence a human
 * (or a beez conflict card) reads.
 */
export class BeezSyncError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        readonly detail?: string,
    ) {
        super(detail ?? code);
        this.name = 'BeezSyncError';
    }
}

/** A caller-supplied idempotency key, or null when the caller opted out. */
export type IdempotencyKey = string | null;

interface Actor {
    /** Token owner, recorded on the audit row. */
    userId: number;
}

// ---------------------------------------------------------------------------
// Book context
// ---------------------------------------------------------------------------

export interface BeezBookContext {
    bookGuid: string;
    bookName: string | null;
    rootAccountGuid: string;
    rootCommodityGuid: string;
    rootCurrency: string;
}

/**
 * The book a token is scoped to, plus its root commodity — the one currency v1
 * accepts. A book whose root account has no commodity cannot be synced at all,
 * and says so rather than defaulting to USD.
 */
export async function getBeezBookContext(bookGuid: string): Promise<BeezBookContext> {
    const book = await prisma.books.findUnique({
        where: { guid: bookGuid },
        select: { guid: true, name: true, root_account_guid: true },
    });
    if (!book) {
        throw new BeezSyncError(404, 'book_not_found', 'This token is scoped to a book that no longer exists');
    }

    const root = await prisma.accounts.findUnique({
        where: { guid: book.root_account_guid },
        select: { commodity_guid: true },
    });
    if (!root?.commodity_guid) {
        throw new BeezSyncError(422, 'no_book_currency', 'The book root account has no commodity, so it has no base currency');
    }

    const commodity = await prisma.commodities.findUnique({
        where: { guid: root.commodity_guid },
        select: { mnemonic: true },
    });

    return {
        bookGuid: book.guid,
        bookName: book.name,
        rootAccountGuid: book.root_account_guid,
        rootCommodityGuid: root.commodity_guid,
        rootCurrency: commodity?.mnemonic ?? 'USD',
    };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface BeezAccount {
    guid: string;
    name: string;
    /** Colon-joined path from the book root, excluding the root itself. */
    fullName: string;
    type: string;
    commodityMnemonic: string | null;
    placeholder: boolean;
    hidden: boolean;
}

interface AccountRow {
    guid: string;
    name: string;
    fullname: string;
    account_type: string;
    mnemonic: string | null;
    placeholder: number | null;
    hidden: number | null;
}

/**
 * Every account under the book's root, with its full path.
 *
 * The path is built by a recursive CTE rooted at THIS book rather than read
 * from the `account_hierarchy` view: that view spans every ROOT account in the
 * database, so on a multi-book installation it would happily hand back a path
 * assembled from another book's tree. Scoping the walk is what makes the answer
 * book-correct by construction.
 */
export async function listBeezAccounts(context: BeezBookContext): Promise<BeezAccount[]> {
    const rows = await prisma.$queryRaw<AccountRow[]>`
        WITH RECURSIVE tree AS (
            SELECT a.guid, a.name, a.name::text AS fullname, a.account_type,
                   a.commodity_guid, a.placeholder, a.hidden
            FROM accounts a
            WHERE a.parent_guid = ${context.rootAccountGuid}
            UNION ALL
            SELECT c.guid, c.name, (t.fullname || ':' || c.name)::text, c.account_type,
                   c.commodity_guid, c.placeholder, c.hidden
            FROM accounts c
            JOIN tree t ON c.parent_guid = t.guid
        )
        SELECT t.guid, t.name, t.fullname, t.account_type,
               cm.mnemonic, t.placeholder, t.hidden
        FROM tree t
        LEFT JOIN commodities cm ON cm.guid = t.commodity_guid
        ORDER BY t.fullname
    `;

    return rows.map(row => ({
        guid: row.guid,
        name: row.name,
        fullName: row.fullname,
        type: row.account_type,
        commodityMnemonic: row.mnemonic,
        // GnuCash stores these as 0/1 integers and leaves them NULL on older
        // books; NULL means "not set", which is "not a placeholder".
        placeholder: row.placeholder === 1,
        hidden: row.hidden === 1,
    }));
}

/**
 * Every account a request names must be in this book, postable, and in the
 * book's own currency.
 *
 * "Not in this book" and "does not exist" share one 404 on purpose — see the
 * cross-book oracle note in the file header.
 */
async function assertAccountsUsable(
    context: BeezBookContext,
    accountGuids: string[],
): Promise<void> {
    const unique = [...new Set(accountGuids)];
    const inBook = new Set(await getAccountGuidsForBook(context.bookGuid));
    if (inBook.size === 0 || unique.some(guid => !inBook.has(guid))) {
        throw new BeezSyncError(404, 'account_not_found', 'One or more accounts were not found in this book');
    }

    // Deliberately the global client, not the caller's transaction client: this
    // reads the chart of accounts, which no beez write touches, so it needs
    // neither that snapshot nor a lock.
    const accounts = await prisma.accounts.findMany({
        where: { guid: { in: unique } },
        select: { guid: true, name: true, commodity_guid: true, placeholder: true },
    });
    if (accounts.length !== unique.length) {
        throw new BeezSyncError(404, 'account_not_found', 'One or more accounts were not found in this book');
    }

    for (const account of accounts) {
        if (account.placeholder === 1) {
            throw new BeezSyncError(
                422,
                'placeholder_account',
                `Account "${account.name}" is a placeholder and cannot hold transactions`,
            );
        }
        if (account.commodity_guid !== context.rootCommodityGuid) {
            throw new BeezSyncError(
                422,
                'currency_mismatch',
                `Account "${account.name}" is not denominated in ${context.rootCurrency}; `
                    + 'v1 of this integration writes book-currency amounts only',
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Link lookups
// ---------------------------------------------------------------------------

interface LinkRow {
    external_id: string;
    entity_guid: string;
}

/**
 * The link for an external id inside ONE book.
 *
 * This lookup is what makes the book scoping of PUT and DELETE complete, and
 * the invariant is worth stating: a link row's `entity_guid` always names a
 * transaction that THIS book's own POST created, because that insert is the
 * only writer of the table. So a link found under `book_guid` can be followed
 * to its transaction without re-deriving book membership from the splits —
 * there is no path by which a link in one book can reference a transaction in
 * another. Any future writer of this table must preserve that.
 */
async function findLinkByExternalId(
    bookGuid: string,
    externalId: string,
    database: DbClient = prisma,
): Promise<LinkRow | null> {
    const row = await database.gnucash_web_external_links.findUnique({
        where: {
            book_guid_source_external_id: {
                book_guid: bookGuid, source: BEEZ_SOURCE, external_id: externalId,
            },
        },
        select: { external_id: true, entity_guid: true, entity_type: true },
    });
    // v1 only ever writes 'transaction' rows, but the table is generic: a
    // future entity type must not be answered as if it were a transaction.
    if (!row || row.entity_type !== 'transaction') return null;
    return { external_id: row.external_id, entity_guid: row.entity_guid };
}

// ---------------------------------------------------------------------------
// Reconciled / frozen guard
// ---------------------------------------------------------------------------

/**
 * Refuse the write when any split of the locked transaction is pinned to a
 * statement, in the SAME sense the rest of the codebase means it.
 *
 * The rule is `assertSplitsNotProtected`, not a local `state === 'y'` test.
 * Reconciled ('y') and frozen ('f') are both agreements with an external
 * statement, and a second spelling of the rule here is precisely how 'f' slipped
 * through: a frozen split could be replaced or deleted through this API while
 * every browser path refused it.
 *
 * PRECONDITION: the caller already holds `SELECT … FOR UPDATE` on the parent
 * transaction row and read `rows` after taking it — otherwise a reconcile
 * committed a moment ago slips past. Both call sites do exactly that.
 *
 * The `ReconciledSplitError` is translated to this API's own 409/`reconciled`
 * rather than the browser API's 423: the wire contract beez was built against
 * names 409, and its message is the one this module already writes.
 */
function assertBeezSplitsWritable(
    verb: 'replaced' | 'deleted',
    rows: ReadonlyArray<{ guid: string; tx_guid?: string | null; account_guid?: string | null; reconcile_state: string | null }>,
): void {
    try {
        assertSplitsNotProtected(
            verb === 'replaced' ? 'replace this transaction' : 'delete this transaction',
            rows,
        );
    } catch (error) {
        if (error instanceof ReconciledSplitError) {
            throw new BeezSyncError(
                409,
                'reconciled',
                `This transaction has splits reconciled or frozen against a statement and cannot be ${verb} from beez. `
                    + error.message,
            );
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// enter_date stamping
// ---------------------------------------------------------------------------

/**
 * Set `enter_date` on a transaction from the DATABASE clock, as late in the
 * write as possible, and return the microsecond string the change feed will
 * render it as.
 *
 * The clock choice is not a detail. `enter_date` is the change feed's ordering
 * key, and this repository writes it from two different clocks: most paths use
 * a JavaScript `new Date()` (the app host), while a few — lot-assignment.ts,
 * reconcile.ts, statement-reconcile-data.ts — use SQL `NOW()` (the database
 * host). App and database are separate machines in every real deployment, so
 * their clocks differ. When the database clock runs ahead, a DB-stamped row
 * pushes the feed watermark into the app clock's future, and every app-stamped
 * transaction written for the next few hundred milliseconds sorts BEHIND that
 * cursor and is never delivered. That is silent, permanent loss of exactly the
 * kind this feed's cursor rules exist to rule out, and it is reproducible: the
 * integration suite catches it whenever the test database's clock leads.
 *
 * Reading the clock the ordering key is compared against removes the skew
 * entirely. `clock_timestamp()` — not `now()`, which is frozen at transaction
 * start and would land BEFORE the idempotency claim and row locks this attempt
 * waited on — is read at the moment of the UPDATE, which is the latest point
 * the writer controls. What remains is the commit-order window documented on
 * `getBeezChanges`, and nothing stamped before COMMIT can close that.
 *
 * The value is returned in {@link ENTER_DATE_PG_FORMAT}, so the API response
 * and the feed payload are byte-identical for the same row — no Date round trip
 * to truncate the microseconds off one of them.
 */
/**
 * How far ahead of the database clock a stored `enter_date` is still treated as
 * a real position the feed must stay above, rather than as corrupt data.
 *
 * Host clock skew is measured in seconds in any deployment that runs NTP, so an
 * hour is generously past every honest case. Beyond it lies data that a broken
 * writer produced — a row dated the year 3000 — and chasing THAT would drag
 * every later `enter_date` in the book into the year 3000 with it, permanently.
 * The bound is the line between absorbing skew and inheriting corruption.
 */
const ENTER_DATE_SKEW_TOLERANCE = '1 hour';

/**
 * Stamp `enter_date` from the DATABASE clock, strictly above every position the
 * feed can already have handed out, and by at least a full millisecond.
 *
 * Three guarantees, one expression, because they are three faces of the same
 * requirement: the value written must be greater than anything a reader could
 * already be holding.
 *
 * 1. DATABASE CLOCK. `clock_timestamp()`, never the app host's `new Date()`.
 *    The two are different machines. It is rendered `AT TIME ZONE 'UTC'` so it
 *    lands on the same scale as every Prisma writer in this repository, which
 *    serializes a JS `Date` as UTC into this `timestamp(6)` column; a database
 *    session on a non-UTC `TimeZone` would otherwise put the two families of
 *    writers hours apart.
 *
 * 2. ABOVE THE FEED. A cursor only ever names a row that exists, so stamping
 *    above the greatest `enter_date` in the table makes this row unmissable by
 *    any cursor issued before it. This is what closes the inverse-skew hole:
 *    if an app-clock writer running fast stamped a row in the future and a poll
 *    advanced the cursor onto it, a plain `clock_timestamp()` here would land
 *    BELOW that cursor and the write would never be delivered. The maximum is
 *    read through `idx_transactions_enter_date_guid`, so it is a one-row
 *    backward index scan, and it is bounded by {@link ENTER_DATE_SKEW_TOLERANCE}
 *    so one corrupt future row cannot poison the column forever.
 *
 * 3. A MILLISECOND CLEAR OF THE PREVIOUS VALUE. The browser's optimistic-lock
 *    token is a JS `Date` and compares at MILLISECOND precision
 *    (src/app/api/transactions/[guid]/route.ts). A microsecond-only bump —
 *    `…123000` to `…123456` — leaves a stale browser token still matching, and
 *    that tab would then overwrite this write without ever seeing a conflict.
 *    Truncating to the millisecond and adding one guarantees the new value
 *    falls in a strictly later millisecond than the old one, so the stale token
 *    stops matching. (The `GREATEST` cannot undo it: any term that wins is
 *    larger still, and the max term already dominates this row's own value.)
 *
 * The remaining, documented window is unchanged and unrelated to clocks: the
 * stamp is taken before COMMIT, so two writers can still commit out of stamp
 * order. See `getBeezChanges`.
 */
async function stampEnterDate(database: DbClient, txGuid: string): Promise<string> {
    const stamped = await database.$queryRaw<Array<{ enter_date: string }>>`
        UPDATE transactions t
        SET enter_date = GREATEST(
                (clock_timestamp() AT TIME ZONE 'UTC'),
                date_trunc('millisecond', t.enter_date) + interval '1 millisecond',
                date_trunc('millisecond', (
                    SELECT max(m.enter_date) FROM transactions m
                    WHERE m.enter_date <= (clock_timestamp() AT TIME ZONE 'UTC')
                                        + ${ENTER_DATE_SKEW_TOLERANCE}::interval
                )) + interval '1 millisecond'
            )
        WHERE t.guid = ${txGuid}
        RETURNING to_char(t.enter_date, ${ENTER_DATE_PG_FORMAT}::text) AS enter_date
    `;
    if (stamped.length === 0) {
        throw new BeezSyncError(500, 'internal', 'Transaction vanished while stamping enter_date');
    }
    return stamped[0].enter_date;
}

// ---------------------------------------------------------------------------
// Idempotency plumbing
// ---------------------------------------------------------------------------

/**
 * Run `write` under a claimed idempotency key, or plainly when the caller sent
 * none.
 *
 * The claim, the ledger write, and the completion are ONE database transaction:
 * a crash rolls all three back, and a newer claimant makes this attempt fail
 * before it can write. That is the same fence the inbound webhooks use, and the
 * reason it is worth the ceremony is that beez retries on timeout — the exact
 * situation where the first attempt may already have committed.
 */
async function withIdempotency<T>(
    bookGuid: string,
    endpoint: WebhookEndpoint,
    key: IdempotencyKey,
    write: (database: DbClient) => Promise<T>,
): Promise<{ result: T; replayed: false } | { result: unknown; replayed: true }> {
    if (!key) {
        const result = await prisma.$transaction(database => write(database), {
            maxWait: 30_000,
            timeout: 30_000,
        });
        return { result, replayed: false };
    }

    const claim = await claimWebhookIdempotency(bookGuid, endpoint, key);
    if (claim.status === 'replay') {
        if (claim.result) return { result: claim.result, replayed: true };
        throw new BeezSyncError(
            409,
            'idempotency_in_flight',
            'A request with this Idempotency-Key is still being processed',
        );
    }
    if (claim.status === 'terminal') {
        throw new BeezSyncError(
            409,
            'idempotency_exhausted',
            `This Idempotency-Key exhausted its retry budget (${claim.attempts} attempts) and needs operator attention`,
        );
    }
    const attempt = claim.attempt;

    try {
        const result = await prisma.$transaction(async (database) => {
            await lockWebhookIdempotencyAttempt(bookGuid, endpoint, key, attempt, database);
            const written = await write(database);
            const completed = await completeWebhookIdempotency(
                bookGuid, endpoint, key, attempt, written, database,
            );
            if (!completed) throw new WebhookClaimSupersededError();
            return written;
        }, { maxWait: 30_000, timeout: 30_000 });
        return { result, replayed: false };
    } catch (error) {
        if (error instanceof WebhookClaimSupersededError) {
            throw new BeezSyncError(
                409,
                'idempotency_in_flight',
                'A newer request with this Idempotency-Key is already in progress',
            );
        }
        // The write did not happen, so the key must not stay burned — a genuine
        // retry has to be able to proceed.
        await releaseWebhookIdempotency(bookGuid, endpoint, key, attempt);
        throw error;
    }
}

/**
 * Post-commit freshness + audit. Never throws: the ledger write already
 * committed, and failing the response afterwards would tell beez to retry a
 * transaction that exists.
 */
async function recordAndInvalidate(
    context: BeezBookContext,
    actor: Actor,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    txGuid: string,
    before: object | null,
    after: object | null,
    affectedDates: Array<Date | null>,
): Promise<void> {
    await logAudit(action, 'TRANSACTION', txGuid, before, after, {
        bookGuid: context.bookGuid,
        userId: actor.userId,
    });

    const earliest = affectedDates
        .filter((date): date is Date => date instanceof Date && !Number.isNaN(date.getTime()))
        .sort((left, right) => left.getTime() - right.getTime())[0];
    if (earliest) {
        try {
            await cacheInvalidateFrom(context.bookGuid, earliest);
        } catch (error) {
            console.warn('beez sync: cache invalidation failed:', error);
        }
    }

    void publishDataChange(context.bookGuid, 'transactions', {
        guid: txGuid,
        action: action === 'CREATE' ? 'create' : action === 'UPDATE' ? 'update' : 'delete',
    });
}

/** Split rows for one transaction, in the shape both writes and reads need. */
function splitRowsFor(txGuid: string, input: BeezTransactionInput) {
    return input.splits.map(split => ({
        guid: generateGuid(),
        tx_guid: txGuid,
        account_guid: split.accountGuid,
        memo: split.memo,
        action: '',
        reconcile_state: 'n',
        reconcile_date: null,
        // v1 is currency-only, so quantity mirrors value exactly: the account's
        // commodity IS the transaction currency, and no exchange rate applies.
        value_num: BigInt(split.amountCents),
        value_denom: CENTS_DENOM,
        quantity_num: BigInt(split.amountCents),
        quantity_denom: CENTS_DENOM,
        lot_guid: null,
    }));
}

/** Audit payload — enough to reconstruct what beez asked for. */
function auditSnapshot(externalId: string, input: BeezTransactionInput) {
    return {
        source: BEEZ_SOURCE,
        external_id: externalId,
        post_date: input.postDate,
        description: input.description,
        num: input.num,
        splits: input.splits.map(split => ({
            account_guid: split.accountGuid,
            amount_cents: split.amountCents,
            memo: split.memo,
        })),
    };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface BeezCreateResult {
    transactionGuid: string;
    /**
     * Microsecond timestamp with a `Z` marker — the same spelling the change
     * feed uses. Null only on an `alreadyLinked` replay whose transaction has a
     * NULL `enter_date`; a freshly created one always carries a stamp.
     */
    enterDate: string | null;
    externalId: string;
    alreadyLinked?: true;
}

/** What a create attempt stores under its Idempotency-Key, verbatim. */
interface BeezCreateOutcome {
    result: BeezCreateResult;
    status: 200 | 201;
}

/**
 * Create the folio transaction beez names `externalId`.
 *
 * Replay behaviour is layered on purpose, because the two mechanisms answer
 * different questions:
 *   - the Idempotency-Key answers "is this the same HTTP request again?";
 *   - the external-id link answers "is this the same beez record again?", which
 *     is still true a week later from a different client with a fresh key.
 * Both end at 200 with `alreadyLinked: true` rather than a second ledger entry.
 *
 * ORDER MATTERS, and it is the opposite of the obvious one. The Idempotency-Key
 * claim is taken FIRST, and every precondition — link lookup, account
 * usability, period lock — runs inside the claimed attempt. A key that has
 * already completed replays its stored response without re-reading anything, so
 * a retry cannot be turned into an error by state that changed after the
 * original succeeded: an account made a placeholder, a period locked, a link
 * since removed. Checking first and claiming second made a successful write
 * answer its own retry with a 404 or 422, which is the failure mode idempotency
 * exists to prevent.
 */
export async function createBeezTransaction(
    context: BeezBookContext,
    actor: Actor,
    input: BeezTransactionInput,
    idempotencyKey: IdempotencyKey,
): Promise<{ result: BeezCreateResult; status: 200 | 201 }> {
    const externalId = input.externalId;
    if (!externalId) {
        throw new BeezSyncError(422, 'validation', 'externalId is required');
    }

    const txGuid = generateGuid();
    const postDate = postDateToTimestamp(input.postDate);
    let created = false;

    try {
        const outcome = await withIdempotency(
            context.bookGuid,
            'beez-transaction-create',
            idempotencyKey,
            async (database): Promise<BeezCreateOutcome> => {
                // Read through the transaction client: the link this looks for
                // is the one the insert below writes, so both must see one
                // snapshot.
                const existing = await findLinkByExternalId(context.bookGuid, externalId, database);
                if (existing) {
                    return { result: await describeExistingLink(context, existing, database), status: 200 };
                }

                await assertAccountsUsable(context, input.splits.map(split => split.accountGuid));

                // Authoritative period-lock check, in-transaction and with the
                // cache bypassed, so a lock set between the request arriving
                // and the write starting still holds.
                await assertNotLocked(context.bookGuid, [postDate], { bypassCache: true, client: database });

                await database.transactions.create({
                    data: {
                        guid: txGuid,
                        currency_guid: context.rootCommodityGuid,
                        num: input.num,
                        post_date: postDate,
                        // Placeholder only. The authoritative value is stamped
                        // from the database clock below, once every write this
                        // attempt can fail on is behind it.
                        enter_date: new Date(0),
                        description: input.description,
                    },
                });
                await database.splits.createMany({ data: splitRowsFor(txGuid, input) });

                // Provenance for every folio surface that asks "where did this
                // come from?". reviewed=true because beez is the system of
                // record for its own records — there is nothing for a human to
                // triage here, unlike a bank import.
                await database.gnucash_web_transaction_meta.create({
                    data: { transaction_guid: txGuid, source: BEEZ_META_SOURCE, reviewed: true },
                });

                // Last, so the UNIQUE violation that a concurrent replay hits
                // rolls back the whole ledger write with it. Written through
                // the typed model rather than $executeRaw specifically so the
                // conflict arrives as a P2002 the caller can recognise — a raw
                // statement surfaces it as an opaque P2010 wrapping SQLSTATE
                // 23505, which is far easier to mis-handle as a 500.
                await database.gnucash_web_external_links.create({
                    data: {
                        book_guid: context.bookGuid,
                        source: BEEZ_SOURCE,
                        external_id: externalId,
                        entity_type: 'transaction',
                        entity_guid: txGuid,
                    },
                });

                // Last write of the attempt, so the feed watermark this row
                // takes is the latest one this writer can honestly claim.
                const enterDate = await stampEnterDate(database, txGuid);

                created = true;
                return {
                    result: {
                        transactionGuid: txGuid,
                        enterDate: `${enterDate}Z`,
                        externalId,
                    },
                    status: 201,
                };
            },
        );

        if (outcome.replayed) {
            // The stored body, marked so the caller can tell a replay from a
            // fresh write without inspecting the status code alone.
            const stored = outcome.result as BeezCreateOutcome;
            return { result: { ...stored.result, alreadyLinked: true }, status: 200 };
        }

        if (created) {
            await recordAndInvalidate(
                context, actor, 'CREATE', txGuid, null, auditSnapshot(externalId, input), [postDate],
            );
        }
        return outcome.result;
    } catch (error) {
        // A concurrent request for the same external id lost the race on
        // uq_external_links_external_id. That is the mechanism working: answer
        // from the row the winner wrote instead of surfacing a 500.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            const winner = await findLinkByExternalId(context.bookGuid, externalId);
            if (winner) {
                return { result: await describeExistingLink(context, winner), status: 200 };
            }
        }
        throw error;
    }
}

/**
 * Answer a replayed POST from the link that already exists.
 *
 * The awkward case is a link whose transaction is gone: someone deleted it in
 * folio and beez has not processed the tombstone yet. Re-creating it here would
 * silently undo a deliberate deletion, so the caller is told to acknowledge the
 * tombstone with DELETE first — the same acknowledgement the change feed asks
 * for. (The v1 wire contract does not name this case; 409 was chosen over
 * resurrecting the row because only one of the two is reversible.)
 */
async function describeExistingLink(
    context: BeezBookContext,
    link: LinkRow,
    database: DbClient = prisma,
): Promise<BeezCreateResult> {
    // Rendered by the database in the feed's own microsecond format, so the
    // `enterDate` a replay reports is byte-identical to the one the change feed
    // reports for the same row. A `Date` here would answer `…123Z` for a row the
    // feed calls `…123456Z`, and a client that compares the two would conclude
    // the transaction had changed.
    const found = await database.$queryRaw<Array<{ guid: string; enter_date: string | null }>>`
        SELECT guid, to_char(enter_date, ${ENTER_DATE_PG_FORMAT}::text) AS enter_date
        FROM transactions WHERE guid = ${link.entity_guid}
    `;
    const transaction = found[0] ?? null;
    if (!transaction) {
        throw new BeezSyncError(
            409,
            'link_orphaned',
            `External id "${link.external_id}" is linked to a transaction that was deleted in folio. `
                + 'Acknowledge the deletion with DELETE before re-creating it.',
        );
    }
    return {
        transactionGuid: transaction.guid,
        enterDate: transaction.enter_date ? `${transaction.enter_date}Z` : null,
        externalId: link.external_id,
        alreadyLinked: true,
    };
}

// ---------------------------------------------------------------------------
// Replace
// ---------------------------------------------------------------------------

export interface BeezReplaceResult {
    transactionGuid: string;
    enterDate: string;
}

/**
 * Replace the description, post date, num, and splits of a linked transaction.
 *
 * The optimistic-lock token that PUT /api/transactions demands from a browser
 * is handled server-side here instead. beez is the system of record for its own
 * records, and it has no `enter_date` to echo back; what it needs is that a
 * concurrent folio edit cannot be half-overwritten. `SELECT … FOR UPDATE`
 * serializes writers, and bumping `enter_date` invalidates every browser tab's
 * token so a human editing the same row in folio gets the 409 they would have
 * got from another human.
 *
 * As with POST, the Idempotency-Key claim is taken BEFORE the link lookup and
 * every other precondition, so a completed attempt replays its stored result
 * rather than being re-judged against state that has since moved.
 */
export async function replaceBeezTransaction(
    context: BeezBookContext,
    actor: Actor,
    externalId: string,
    input: BeezTransactionInput,
    idempotencyKey: IdempotencyKey,
): Promise<BeezReplaceResult> {
    const postDate = postDateToTimestamp(input.postDate);
    let previousPostDate: Date | null = null;
    let replacedTxGuid: string | null = null;

    const outcome = await withIdempotency(
        context.bookGuid,
        'beez-transaction-update',
        idempotencyKey,
        async (database) => {
            const link = await findLinkByExternalId(context.bookGuid, externalId, database);
            if (!link) {
                throw new BeezSyncError(
                    404, 'unknown_external_id', `No folio transaction is linked to "${externalId}"`,
                );
            }
            const txGuid = link.entity_guid;

            await assertAccountsUsable(context, input.splits.map(split => split.accountGuid));

            const locked = await database.$queryRaw<Array<{ guid: string; post_date: Date | null }>>`
                SELECT guid, post_date FROM transactions WHERE guid = ${txGuid} FOR UPDATE
            `;
            if (locked.length === 0) {
                throw new BeezSyncError(
                    404,
                    'unknown_external_id',
                    `External id "${externalId}" is linked to a transaction that no longer exists`,
                );
            }
            previousPostDate = locked[0].post_date;

            const existingSplits = await database.splits.findMany({
                where: { tx_guid: txGuid },
                select: { guid: true, tx_guid: true, account_guid: true, reconcile_state: true },
            });
            // Read inside the transaction and AFTER the parent FOR UPDATE, which
            // is the precondition the shared guard documents: a reconcile
            // committed a millisecond ago cannot slip past it.
            assertBeezSplitsWritable('replaced', existingSplits);

            await assertNotLocked(
                context.bookGuid,
                [locked[0].post_date, postDate],
                { bypassCache: true, client: database },
            );

            await database.transactions.update({
                where: { guid: txGuid },
                data: {
                    currency_guid: context.rootCommodityGuid,
                    num: input.num,
                    post_date: postDate,
                    description: input.description,
                },
            });

            // `slots` has no foreign key on obj_guid, so slots attached to the
            // splits we are about to drop would leak as orphans. Every split is
            // recreated with a new guid here, so all of them go.
            await database.slots.deleteMany({
                where: { obj_guid: { in: existingSplits.map(split => split.guid) } },
            });
            await database.splits.deleteMany({ where: { tx_guid: txGuid } });
            await database.splits.createMany({ data: splitRowsFor(txGuid, input) });

            await database.gnucash_web_transaction_meta.upsert({
                where: { transaction_guid: txGuid },
                create: { transaction_guid: txGuid, source: BEEZ_META_SOURCE, reviewed: true },
                update: { source: BEEZ_META_SOURCE, reviewed: true },
            });

            await database.gnucash_web_external_links.update({
                where: {
                    book_guid_source_external_id: {
                        book_guid: context.bookGuid, source: BEEZ_SOURCE, external_id: externalId,
                    },
                },
                data: { updated_at: new Date() },
            });

            // Always a fresh timestamp: it is both the change-feed ordering key
            // and every other writer's version token, so a browser tab holding
            // the old one gets the 409 it would have got from another human.
            // Stamped last, after the lock wait and every dependent write.
            const enterDate = await stampEnterDate(database, txGuid);

            replacedTxGuid = txGuid;
            return {
                transactionGuid: txGuid,
                enterDate: `${enterDate}Z`,
            } satisfies BeezReplaceResult;
        },
    );

    if (outcome.replayed) return outcome.result as BeezReplaceResult;

    if (replacedTxGuid) {
        await recordAndInvalidate(
            context, actor, 'UPDATE', replacedTxGuid, { external_id: externalId },
            auditSnapshot(externalId, input), [postDate, previousPostDate],
        );
    }
    return outcome.result;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface BeezDeleteResult {
    deleted: true;
    /** True when only a tombstone link was cleared — the ledger was untouched. */
    orphanLinkRemoved?: true;
}

/**
 * Delete the linked transaction and its link.
 *
 * A link whose transaction is already gone is NOT an error: it is the tombstone
 * the change feed emitted, and this call is beez acknowledging it. Removing the
 * row is the whole point — it is what makes the tombstone stop repeating.
 *
 * The Idempotency-Key claim is taken BEFORE the link lookup, and that ordering
 * is the entire point of the key here. A DELETE that succeeded and then timed
 * out on the wire is retried by beez; with the lookup first, the retry found no
 * link — because the first call removed it — and answered 404 for a deletion
 * that had in fact happened. Claim-first replays the stored `{ deleted: true }`.
 */
export async function deleteBeezTransaction(
    context: BeezBookContext,
    actor: Actor,
    externalId: string,
    idempotencyKey: IdempotencyKey,
): Promise<BeezDeleteResult> {
    let deletedPostDate: Date | null = null;
    let deletedTxGuid: string | null = null;

    const outcome = await withIdempotency(
        context.bookGuid,
        'beez-transaction-delete',
        idempotencyKey,
        async (database) => {
            const link = await findLinkByExternalId(context.bookGuid, externalId, database);
            if (!link) {
                throw new BeezSyncError(
                    404, 'unknown_external_id', `No folio transaction is linked to "${externalId}"`,
                );
            }
            const txGuid = link.entity_guid;
            let wasOrphan = false;

            const locked = await database.$queryRaw<Array<{ guid: string; post_date: Date | null }>>`
                SELECT guid, post_date FROM transactions WHERE guid = ${txGuid} FOR UPDATE
            `;

            if (locked.length > 0) {
                deletedPostDate = locked[0].post_date;

                const existingSplits = await database.splits.findMany({
                    where: { tx_guid: txGuid },
                    select: { guid: true, tx_guid: true, account_guid: true, reconcile_state: true },
                });
                // After the parent FOR UPDATE above, as the shared guard requires.
                assertBeezSplitsWritable('deleted', existingSplits);

                await assertNotLocked(
                    context.bookGuid, [locked[0].post_date], { bypassCache: true, client: database },
                );

                await database.gnucash_web_transaction_meta.deleteMany({
                    where: { transaction_guid: txGuid },
                });
                // Transaction-level slots as well as split-level ones; neither
                // has a foreign key to cascade from.
                await database.slots.deleteMany({
                    where: { obj_guid: { in: [...existingSplits.map(split => split.guid), txGuid] } },
                });
                await database.splits.deleteMany({ where: { tx_guid: txGuid } });
                await database.transactions.delete({ where: { guid: txGuid } });
                deletedTxGuid = txGuid;
            } else {
                wasOrphan = true;
            }

            await database.gnucash_web_external_links.deleteMany({
                where: {
                    book_guid: context.bookGuid,
                    source: BEEZ_SOURCE,
                    entity_type: 'transaction',
                    external_id: externalId,
                },
            });

            return (wasOrphan
                ? { deleted: true, orphanLinkRemoved: true }
                : { deleted: true }) satisfies BeezDeleteResult;
        },
    );

    if (outcome.replayed) return outcome.result as BeezDeleteResult;

    if (deletedTxGuid) {
        await recordAndInvalidate(
            context, actor, 'DELETE', deletedTxGuid,
            { source: BEEZ_SOURCE, external_id: externalId, post_date: timestampToPostDate(deletedPostDate) },
            null, [deletedPostDate],
        );
    }
    return outcome.result;
}

// ---------------------------------------------------------------------------
// Change feed
// ---------------------------------------------------------------------------

export interface BeezChangeSplit {
    accountGuid: string;
    amountCents: number;
    memo: string;
    reconcileState: string;
}

export interface BeezChangeItem {
    transactionGuid?: string;
    externalId: string | null;
    postDate?: string | null;
    enterDate?: string | null;
    description?: string | null;
    splits?: BeezChangeSplit[];
    deleted: boolean;
    /**
     * Set when at least one split cannot be stated exactly in cents. `splits`
     * is then empty — see the cents discipline in src/lib/integrations/beez.ts.
     */
    unrepresentable?: true;
}

export interface BeezChanges {
    items: BeezChangeItem[];
    nextCursor: string | null;
    hasMore: boolean;
}

/**
 * True for the PostgreSQL failures a `::timestamp` cast raises on a value whose
 * fields are out of range (`22008`) or unparseable (`22007`).
 *
 * Prisma surfaces a raw-query failure as `P2010` and keeps the underlying
 * SQLSTATE in `meta.code`; the message match is the fallback for a driver that
 * does not, and both are cheap next to letting the caller see a 500.
 */
function isTimestampCastFailure(error: unknown): boolean {
    const code = (error as { meta?: { code?: unknown } } | null)?.meta?.code;
    if (code === '22007' || code === '22008') return true;
    const message = error instanceof Error ? error.message : '';
    return /date\/time field value out of range|invalid input syntax for type timestamp/i.test(message);
}

interface ChangeTxRow {
    guid: string;
    post_date: Date | null;
    /**
     * The raw microsecond string PostgreSQL rendered, NOT a JS Date, and null
     * only for the always-emitted NULL-enter_date set. A Date here would
     * silently drop the microseconds the cursor is built from.
     */
    enter_date: string | null;
    description: string | null;
}

interface ChangeSplitRow {
    tx_guid: string;
    account_guid: string;
    memo: string | null;
    reconcile_state: string;
    value_num: bigint;
    value_denom: bigint;
}

/**
 * Transactions entered after the cursor, oldest first, plus two always-emitted
 * sets: NULL-enter_date rows and deletion tombstones.
 *
 * ORDERING. `(enter_date, guid)` is the only total order that stays stable
 * while rows are being written: post_date has ties and moves backwards on an
 * edit, and `guid` breaks the remaining ties deterministically. The cursor
 * therefore encodes ONLY a non-NULL `(enter_date, guid)` watermark, and the
 * comparison is the tuple one — `enter_date` greater, or equal with a greater
 * guid. Comparing `enter_date` alone with `>` would skip every other row minted
 * in the same microsecond.
 *
 * PRECISION. `enter_date` is read with `to_char(…, 'YYYY-MM-DD"T"HH24:MI:SS.US')`
 * and travels through the cursor as that exact string. Nothing on this path
 * builds a JS `Date`: a Date holds milliseconds, so a row stored at `…56.123456`
 * would produce a `…56.123` cursor, still compare greater than it on the next
 * poll, and re-emit itself forever.
 *
 * NULL enter_date. GnuCash permits it, and such a row has no position in the
 * order above at all. Two earlier designs lost data here and both are worth
 * naming, because the fix is shaped by them. Seating a NULL row in the time
 * watermark — a cursor that said "NULL tail" — meant that once a client
 * consumed one, every LATER transaction with a normal enter_date sorted before
 * the cursor and was skipped permanently. Emitting the NULL set unpaged on
 * every response fixed that but lost the tail instead: with more NULL rows than
 * `limit`, the same guid-ordered prefix came back forever and the rest was
 * unreachable, while `hasMore` — computed from the ordered stream alone — said
 * there was nothing left to fetch.
 *
 * So the NULL set is its own paged stream, with its own watermark in the
 * cursor (`nullGuid`), ordered by guid, bounded by `limit`, and NOT counted
 * against the ordered page's budget. It advances while rows remain and RESETS
 * to the start the moment it drains, which is what keeps a NULL row inserted
 * behind an advanced watermark reachable: a row with no timestamp gives no
 * "after" to scan from, the drain always terminates because the watermark
 * strictly advances, and the pass after it starts over and sees whatever
 * arrived. `hasMore` is true when EITHER stream has more. Bounded repetition of
 * a drained set is the price; silent loss is not on the menu.
 *
 * TOMBSTONES. A link row whose transaction is gone is emitted as
 * `{ externalId, deleted: true }` on EVERY page until beez acknowledges it with
 * DELETE. Same reasoning: a deleted row has no enter_date to sort by, so
 * repeating a bounded, self-draining set is the honest alternative to inventing
 * a position for it. Tombstones do not count towards `limit` for the
 * transaction page or advance `nextCursor`.
 *
 * ONE CLOCK. The ordering key is DATABASE-owned. `stampEnterDate` writes
 * `clock_timestamp()` and additionally never lands below the greatest
 * `enter_date` already in the table, and the browser's own edit path
 * (`PUT /api/transactions/[guid]`) now writes the database clock too rather
 * than the app host's `new Date()`. That combination is what closes the
 * inverse-skew hole: an app host running fast could otherwise stamp a row in
 * the future, a poll would advance the watermark onto it, and every
 * database-clock write for the next few seconds would sort behind the cursor
 * and be lost. Older rows minted by a fast clock, and the remaining app-clock
 * writers elsewhere in the repository, stay safe for the same reason — the
 * stamp climbs above them rather than assuming they do not exist.
 *
 * STALENESS WINDOW (known, bounded, and documented on the route). The stamp is
 * taken as late as a writer can take it — after every idempotency claim and row
 * lock that attempt can block on, and after its dependent writes — but still
 * before COMMIT. Two writers can therefore commit out of timestamp order: A
 * stamps T1, B stamps T2 > T1 and commits first, a poll advances the cursor
 * past T2, then A commits at T1 and sits behind the watermark. Nothing stamped
 * before COMMIT can close that window; taking it last shrinks it to the
 * remaining transaction duration. A client that needs certainty re-polls from
 * an older cursor — this feed's items are keyed by `transactionGuid` /
 * `externalId` and are safe to apply twice.
 */
export async function getBeezChanges(
    context: BeezBookContext,
    options: { since: string | null; limit: number },
): Promise<BeezChanges> {
    let cursor: ChangesCursor | null = null;
    if (options.since !== null && options.since !== '') {
        cursor = decodeChangesCursor(options.since);
        if (!cursor) {
            throw new BeezSyncError(422, 'validation', 'since: not a cursor issued by this endpoint');
        }
    }

    const bookAccountGuids = await getAccountGuidsForBook(context.bookGuid);
    if (bookAccountGuids.length === 0) {
        return { items: [], nextCursor: options.since ?? null, hasMore: false };
    }

    // A transaction belongs to this book when any of its splits posts to a
    // book account — the same definition GET /api/transactions uses.
    const inBook = Prisma.sql`EXISTS (
        SELECT 1 FROM splits s
        WHERE s.tx_guid = t.guid AND s.account_guid = ANY(${bookAccountGuids}::text[])
    )`;

    // The cursor string is compared as a timestamp, not as text: `::timestamp`
    // parses the microseconds, where a text comparison would depend on the
    // rendering being byte-identical. A null `enterDate` means the ordered
    // stream has not started yet (the client is only part-way through the NULL
    // set), which is a scan from the beginning — never a skip.
    const afterCursor: Prisma.Sql = cursor && cursor.enterDate !== null
        ? Prisma.sql`(t.enter_date, t.guid) > (${cursor.enterDate}::timestamp, ${cursor.guid})`
        : Prisma.sql`TRUE`;

    // One extra row is the cheapest honest hasMore: it answers "is there a
    // next page?" without a second COUNT over the same predicate.
    let rows: ChangeTxRow[];
    try {
        rows = await prisma.$queryRaw<ChangeTxRow[]>`
            SELECT t.guid, t.post_date, t.description,
                   to_char(t.enter_date, ${ENTER_DATE_PG_FORMAT}::text) AS enter_date
            FROM transactions t
            WHERE ${inBook} AND t.enter_date IS NOT NULL AND ${afterCursor}
            ORDER BY t.enter_date ASC, t.guid ASC
            LIMIT ${options.limit + 1}
        `;
    } catch (error) {
        // `decodeChangesCursor` already range-checks the timestamp, so reaching
        // this is a bug in that gate rather than a normal path. Answering 422
        // anyway keeps the failure attributable to the input the client sent
        // instead of surfacing a 500 that reads like a server fault.
        if (isTimestampCastFailure(error)) {
            throw new BeezSyncError(422, 'validation', 'since: not a cursor issued by this endpoint');
        }
        throw error;
    }
    const orderedHasMore = rows.length > options.limit;
    const page = orderedHasMore ? rows.slice(0, options.limit) : rows;

    // The NULL set, paged on its own guid watermark and its own budget. The
    // extra row answers "is this set drained?" — and the answer decides between
    // advancing the watermark and restarting the set (see the header).
    const afterNullCursor: Prisma.Sql = cursor && cursor.nullGuid !== null
        ? Prisma.sql`t.guid > ${cursor.nullGuid}`
        : Prisma.sql`TRUE`;
    const nullRows = await prisma.$queryRaw<ChangeTxRow[]>`
        SELECT t.guid, t.post_date, t.description, NULL::text AS enter_date
        FROM transactions t
        WHERE ${inBook} AND t.enter_date IS NULL AND ${afterNullCursor}
        ORDER BY t.guid ASC
        LIMIT ${options.limit + 1}
    `;
    const nullHasMore = nullRows.length > options.limit;
    const nullEnterDateRows = nullHasMore ? nullRows.slice(0, options.limit) : nullRows;
    // Advance while rows remain; reset on drain so a NULL row that appears
    // behind the watermark is picked up by the next pass.
    const nextNullGuid = nullHasMore
        ? nullEnterDateRows[nullEnterDateRows.length - 1].guid
        : null;

    const hasMore = orderedHasMore || nullHasMore;

    const delivered = [...page, ...nullEnterDateRows];
    const guids = delivered.map(row => row.guid);
    const [splitRows, linkRows] = await Promise.all([
        guids.length > 0
            ? prisma.$queryRaw<ChangeSplitRow[]>`
                SELECT tx_guid, account_guid, memo, reconcile_state, value_num, value_denom
                FROM splits WHERE tx_guid = ANY(${guids}::text[])
                ORDER BY tx_guid, guid
            `
            : Promise.resolve([] as ChangeSplitRow[]),
        guids.length > 0
            ? prisma.$queryRaw<LinkRow[]>`
                SELECT external_id, entity_guid
                FROM gnucash_web_external_links
                WHERE book_guid = ${context.bookGuid} AND source = ${BEEZ_SOURCE}
                  AND entity_type = 'transaction'
                  AND entity_guid = ANY(${guids}::text[])
            `
            : Promise.resolve([] as LinkRow[]),
    ]);

    const splitsByTx = new Map<string, ChangeSplitRow[]>();
    for (const split of splitRows) {
        const bucket = splitsByTx.get(split.tx_guid);
        if (bucket) bucket.push(split);
        else splitsByTx.set(split.tx_guid, [split]);
    }
    const externalIdByTx = new Map(linkRows.map(row => [row.entity_guid, row.external_id]));

    const items: BeezChangeItem[] = delivered.map((row) => {
        const rawSplits = splitsByTx.get(row.guid) ?? [];
        const converted = rawSplits.map(split => ({
            split,
            cents: splitValueToCents(split.value_num, split.value_denom),
        }));

        const base: BeezChangeItem = {
            transactionGuid: row.guid,
            externalId: externalIdByTx.get(row.guid) ?? null,
            postDate: timestampToPostDate(row.post_date),
            // The database's own microsecond rendering, with the UTC marker the
            // column's convention implies. NOT a Date round trip, which would
            // truncate to milliseconds and desynchronize the payload from the
            // cursor built out of the same string.
            enterDate: row.enter_date ? `${row.enter_date}Z` : null,
            description: row.description,
            deleted: false,
        };

        // All-or-nothing: a transaction with one 1/3 split is reported whole as
        // a conflict rather than as a partial set of splits that would not
        // balance on the beez side. Rounding it into cents is forbidden — it
        // would invent money (see src/lib/integrations/beez.ts).
        if (converted.some(entry => entry.cents === null)) {
            return { ...base, splits: [], unrepresentable: true };
        }

        return {
            ...base,
            splits: converted.map(entry => ({
                accountGuid: entry.split.account_guid,
                amountCents: entry.cents as number,
                memo: entry.split.memo ?? '',
                reconcileState: entry.split.reconcile_state,
            })),
        };
    });

    const tombstones = await prisma.$queryRaw<Array<{ external_id: string }>>`
        SELECT l.external_id
        FROM gnucash_web_external_links l
        WHERE l.book_guid = ${context.bookGuid} AND l.source = ${BEEZ_SOURCE}
          AND l.entity_type = 'transaction'
          AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.guid = l.entity_guid)
        ORDER BY l.external_id
        LIMIT ${options.limit}
    `;
    for (const tombstone of tombstones) {
        items.push({ externalId: tombstone.external_id, deleted: true });
    }

    // Each stream advances its own half of the cursor. An empty ordered page
    // must not reset the client to the beginning of the feed, so the time
    // watermark it sent is carried forward untouched.
    const last = page[page.length - 1];
    const position = last && last.enter_date
        ? { enterDate: last.enter_date, guid: last.guid }
        : { enterDate: cursor?.enterDate ?? null, guid: cursor?.guid ?? null };

    // Nothing to name in either stream — an empty book — so the client starts
    // from the beginning next time, which is where it already is.
    const nextCursor = position.enterDate !== null || nextNullGuid !== null
        ? encodeChangesCursor({ ...position, nullGuid: nextNullGuid })
        : null;

    return { items, nextCursor, hasMore };
}
