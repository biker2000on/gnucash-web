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
import {
    assertNotLocked,
    findLockedDate,
    getCachedLockDate,
} from '@/lib/services/period-lock.service';
import {
    BEEZ_FEED_OVERLAP,
    EnterDateStampError,
    enterDateHorizonSql,
    stampEnterDate,
} from '@/lib/enter-date';
import {
    assertSplitsNotProtected,
    isProtectedReconcileState,
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
 * Stamp `enter_date` on a transaction, mapping the shared helper's only failure
 * onto this contract's wire vocabulary.
 *
 * The stamping RULE itself is not defined here on purpose — it lives in
 * src/lib/enter-date.ts, because this feed's ordering key is written by a dozen
 * routes across the app and a rule that only the beez path obeyed would leave
 * exactly the hole it was written to close. See that module for the invariant.
 */
async function stampBeezEnterDate(database: DbClient, txGuid: string): Promise<string> {
    try {
        return await stampEnterDate(database, txGuid);
    } catch (error) {
        if (error instanceof EnterDateStampError) {
            throw new BeezSyncError(500, 'internal', error.message);
        }
        throw error;
    }
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
                const enterDate = await stampBeezEnterDate(database, txGuid);

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
            const enterDate = await stampBeezEnterDate(database, txGuid);

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
    /**
     * Set on an item from the always-emitted quarantine set: a row with no
     * `enter_date` at all, or one stamped beyond the skew horizon
     * (src/lib/enter-date.ts). Such a row has no position in the feed's time
     * order, so it is re-delivered on every poll instead of being sequenced —
     * apply it idempotently by `transactionGuid` and it costs nothing. It is
     * NOT a data problem the client must surface, unlike `unrepresentable`.
     */
    quarantined?: true;
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
 * sets: quarantined rows and deletion tombstones.
 *
 * ORDERING. `(enter_date, guid)` is the only total order that stays stable
 * while rows are being written: post_date has ties and moves backwards on an
 * edit, and `guid` breaks the remaining ties deterministically. The comparison
 * is the tuple one — `enter_date` greater, or equal with a greater guid.
 * Comparing `enter_date` alone with `>` would skip every other row minted in
 * the same microsecond.
 *
 * BOUNDED OVERLAP — the reason this is a SWEEP and not a strict watermark.
 *
 * Only a handful of writers in this repository stamp `enter_date` through the
 * ordering-safe helper (src/lib/enter-date.ts). Dozens do not: the SimpleFin
 * sync, the invoice engine, the Stripe webhook, the inbound webhook, the CSV /
 * QIF / QBO / settlement importers, `reconcile.ts`,
 * `statement-reconcile-data.ts`, `lot-assignment.ts`, `lot-scrub.ts`,
 * `transaction.service.ts`, `inventory-engine.ts`, and so on all write a bare
 * `NOW()` / `new Date()`. Because a cursor may legitimately sit up to
 * ENTER_DATE_SKEW_TOLERANCE (one hour) ahead of the wall clock, a bare-clock
 * row can land BELOW a cursor already in a client's hands, and a strictly
 * forward watermark would skip it permanently. Auditing every writer forever is
 * not a design; it is a list that goes stale the next time somebody adds one.
 *
 * So the READER carries the burden. The cursor holds three things:
 *
 *  - the HIGH WATERMARK — the greatest `(enter_date, guid)` ever emitted to
 *    this client. Monotone; it never rewinds.
 *  - the SWEEP POSITION — how far the current GENERATION has read. It advances
 *    while the generation has more, and is CLEARED when it drains.
 *  - the SWEEP BASE — the watermark the current generation BEGAN with, fixed
 *    for its whole life. The next generation's floor is measured down from it.
 *
 * A generation with no sweep position starts at `sweepBase - BEEZ_FEED_OVERLAP`
 * (two hours) and re-emits everything at or above that floor. The wire contract
 * already requires idempotent apply by `transactionGuid`, so re-emission costs
 * the client nothing; `enterDate` is byte-identical across the repeats, so the
 * pair is also a usable dedup key.
 *
 * WHY THE FLOOR IS PINNED AT THE START AND NOT THE END. Deriving it from the
 * watermark a generation ENDED on ages out writes that landed behind a live
 * sweep position, and that is not hypothetical: a generation whose position had
 * reached `t + 30m` when a bare-clock writer stamped `t`, and which then read
 * on — slowly, over real hours — to a final row at `t + 3h` before draining,
 * would hand its successor a floor of `t + 1h`. The row at `t` is below the
 * successor's floor and above nothing the generation itself will read again: it
 * is lost. A base fixed when the generation STARTED cannot be moved by what the
 * generation subsequently reads, so one complete overlap generation is always
 * retained and the write behind the live position is picked up next time round.
 * A generation that starts with no watermark at all pins the database clock
 * instead, which has the same property for every write from that moment on.
 *
 * THE GUARANTEE, precisely. Let H be the horizon (1 hour) and V the overlap
 * (2 hours). The highest cursor the feed can ever issue is at most H ahead of
 * the database clock, because the horizon excludes everything above that from
 * the ORDER. A generation that starts at time p therefore pins a base of at
 * most `p + H`, so its successor's floor is at most `p + H - V` — one hour
 * BEHIND p. Every write made from p onwards is stamped at least `(V - H)` above
 * that floor's worst case. Therefore:
 *
 *   A row is delivered if its stamp is no more than (V - H) behind true time
 *   at the moment it is written — one hour, at these values.
 *
 * The bound is INCLUSIVE, and the comparison in the query is `>=` to match:
 * `p + H - V` is a floor a real row can land exactly on, and a strict `>` would
 * drop the one case the contract is written around. A duplicate is the price.
 *
 * Every bare-clock writer above satisfies that on any host running NTP, which
 * is how they are covered without being touched. V > H is what makes the margin
 * positive at all; a smaller overlap would guarantee nothing.
 *
 * WHY TWO POSITIONS AND NOT ONE. Re-deriving the floor from a single watermark
 * deadlocks as soon as the overlap band holds more than `limit` rows: every
 * poll re-reads the same first page, re-issues the same watermark, and the rest
 * of the band is never reached. A bulk import of a few thousand rows would do
 * it. Separating "how far this pass has read" from "the highest thing ever
 * sent" makes each pass strictly advance — so it terminates — while the pass
 * after it still starts low enough to catch a late-landing write.
 *
 * WHAT THE OVERLAP CANNOT COVER is a write stamped far in the PAST: no bounded
 * window catches an arbitrarily old timestamp. Those writers — the audit undo's
 * snapshot restore — stamp through `stampEnterDate` instead, which is why the
 * historical value stays in the audit record rather than on the live row.
 *
 * PRECISION. `enter_date` is read with `to_char(…, 'YYYY-MM-DD"T"HH24:MI:SS.US')`
 * and travels through the cursor as that exact string. Nothing on this path
 * builds a JS `Date`: a Date holds milliseconds, so a row stored at `…56.123456`
 * would produce a `…56.123` cursor, still compare greater than it on the next
 * poll, and re-emit itself forever.
 *
 * ROWS WITH NO POSITION. Two kinds: `enter_date IS NULL` (GnuCash permits it,
 * and the desktop client writes them) and `enter_date` beyond the writers'
 * skew horizon (src/lib/enter-date.ts). Neither has a position in the order
 * above at all. Two earlier designs lost data here and both are worth
 * naming, because the fix is shaped by them. Seating a NULL row in the time
 * watermark — a cursor that said "NULL tail" — meant that once a client
 * consumed one, every LATER transaction with a normal enter_date sorted before
 * the cursor and was skipped permanently. Emitting the NULL set unpaged on
 * every response fixed that but lost the tail instead: with more NULL rows than
 * `limit`, the same guid-ordered prefix came back forever and the rest was
 * unreachable, while `hasMore` — computed from the ordered stream alone — said
 * there was nothing left to fetch.
 *
 * So the quarantine set is its own paged stream, with its own watermark in the
 * cursor (`nullGuid`), ordered by guid, bounded by `limit`, and NOT counted
 * against the ordered page's budget. Its items are flagged `quarantined: true`.
 *
 * THE HORIZON IS WHY THE FUTURE ROW IS IN THAT SET. A writer's floor is the
 * greatest `enter_date` within one hour of the database clock; ordering a row
 * beyond that would issue a cursor no writer could ever climb above, and every
 * later write would sort behind it — permanently, for a row dated the year
 * 3000. Excluding it from the ORDER costs nothing: it is delivered on every
 * poll while it is out there, and rejoins the ordered stream the moment the
 * clock reaches it. Reader and writer read the same horizon expression, which
 * is what makes "every issued cursor <= every writer's floor" true rather than
 * hoped for. It advances while rows remain and RESETS
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
 * THE STAMPER, for the writers that use it. The beez mutations, the transaction
 * editor's PUT, the bulk edit, the reconcile/lot split paths, and the audit undo
 * restore stamp through `stampEnterDate`/`stampEnterDates` in
 * src/lib/enter-date.ts. That helper writes `clock_timestamp()` and never lands
 * below the greatest admitted `enter_date` already in the table, so those rows
 * are unmissable by construction rather than by overlap — they cannot land
 * below an issued cursor at all. It is belt AND braces: the overlap would catch
 * them anyway, but the ordering stays clean, and the transaction editor's
 * optimistic-lock token needs that strict millisecond bump regardless.
 *
 * STALENESS WINDOW (known, bounded, and documented on the route). The stamp is
 * taken as late as a writer can take it — after every idempotency claim and row
 * lock that attempt can block on, and after its dependent writes — but still
 * before COMMIT. Two writers can therefore commit out of timestamp order: A
 * stamps T1, B stamps T2 > T1 and commits first, a poll advances the cursor
 * past T2, then A commits at T1 and sits behind the watermark. Nothing stamped
 * before COMMIT can close that window at the writer. The overlap closes it at
 * the reader: A's row stays above the next pass's floor for two hours after it
 * lands, so any poll inside that window delivers it.
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

    // WHERE THIS SWEEP STARTS. Three cases, in priority order:
    //
    //  1. MID-SWEEP — the client holds a sweep position, so continue strictly
    //     after it. This is the ordinary paging case and it never re-emits.
    //  2. GENERATION DRAINED — no sweep position, but a base to floor down
    //     from. Restart BEEZ_FEED_OVERLAP below the base the DRAINED generation
    //     began with and re-read the band, which is what catches a bare-clock
    //     writer's row that landed underneath it. No guid tie-break is needed
    //     or wanted here: the floor is a time, and re-reading a row that sits
    //     exactly on it is harmless.
    //  3. NEITHER — the stream has not started at all (a brand new client).
    //     Scan from the beginning.
    //
    // THE FLOOR IS `>=`, NOT `>`. The contract this feed sells is inclusive: a
    // write is delivered if its stamp is no more than (overlap - horizon)
    // behind true time. That bound is REACHED in the worst case — a base
    // sitting the full horizon ahead of the clock puts the floor exactly on the
    // oldest stamp the contract promises to carry — and a strict comparison
    // would drop precisely that row. An inclusive one costs a duplicate.
    //
    // The cursor strings are compared as timestamps, not as text: `::timestamp`
    // parses the microseconds, where a text comparison would depend on the
    // rendering being byte-identical.
    const floorBase = cursor === null ? null : cursor.sweepBase ?? cursor.enterDate;
    const afterCursor: Prisma.Sql = cursor && cursor.sweepEnterDate !== null
        ? Prisma.sql`(t.enter_date, t.guid) > (${cursor.sweepEnterDate}::timestamp, ${cursor.sweepGuid})`
        : floorBase !== null
            ? Prisma.sql`t.enter_date >= (${floorBase}::timestamp - ${BEEZ_FEED_OVERLAP}::interval)`
            : Prisma.sql`TRUE`;

    // THE BASE THIS GENERATION IS PINNED TO, decided before a single row is
    // read so that nothing this pass reads can move it.
    //
    //  - mid-sweep: the generation already has one; carry it unchanged.
    //  - a fresh generation with a watermark: the watermark, as it stands NOW.
    //  - a fresh generation without one (a brand new client, or one still only
    //    part-way through the quarantine set): the database clock. Nothing
    //    written from this moment on can be more than (overlap - horizon)
    //    below it, which is the same property a watermark has.
    //
    // The one case that still yields no base is a client mid-sweep on a cursor
    // minted before this field existed. That generation drains with a null base
    // and its successor falls back to the high watermark for one pass — the old
    // behaviour, once, on upgrade — after which every generation is pinned.
    const generationBase: string | null = cursor === null
        ? await readDatabaseClockStamp()
        : cursor.sweepEnterDate !== null
            ? cursor.sweepBase
            : cursor.enterDate ?? cursor.sweepBase ?? await readDatabaseClockStamp();

    // One extra row is the cheapest honest hasMore: it answers "is there a
    // next page?" without a second COUNT over the same predicate.
    let rows: ChangeTxRow[];
    try {
        rows = await prisma.$queryRaw<ChangeTxRow[]>`
            SELECT t.guid, t.post_date, t.description,
                   to_char(t.enter_date, ${ENTER_DATE_PG_FORMAT}::text) AS enter_date
            FROM transactions t
            WHERE ${inBook} AND t.enter_date IS NOT NULL
              AND t.enter_date <= ${enterDateHorizonSql} AND ${afterCursor}
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

    // The QUARANTINE set, paged on its own guid watermark and its own budget.
    // The extra row answers "is this set drained?" — and the answer decides
    // between advancing the watermark and restarting the set (see the header).
    //
    // Two kinds of row have no position in the time order and so land here:
    // `enter_date IS NULL`, and `enter_date` beyond the writers' horizon. The
    // second is what keeps the reader and the writers honest with each other:
    // ordering a year-3000 row would issue a cursor no writer's watermark could
    // ever reach, and every later write would sort behind it forever. Excluding
    // it from the ORDER is not dropping it — it is delivered here, on every
    // poll, until the clock catches up and it rejoins the ordered stream.
    const afterNullCursor: Prisma.Sql = cursor && cursor.nullGuid !== null
        ? Prisma.sql`t.guid > ${cursor.nullGuid}`
        : Prisma.sql`TRUE`;
    const quarantineRows = await prisma.$queryRaw<ChangeTxRow[]>`
        SELECT t.guid, t.post_date, t.description,
               to_char(t.enter_date, ${ENTER_DATE_PG_FORMAT}::text) AS enter_date
        FROM transactions t
        WHERE ${inBook} AND ${afterNullCursor}
          AND (t.enter_date IS NULL OR t.enter_date > ${enterDateHorizonSql})
        ORDER BY t.guid ASC
        LIMIT ${options.limit + 1}
    `;
    const quarantineHasMore = quarantineRows.length > options.limit;
    const quarantinePage = quarantineHasMore
        ? quarantineRows.slice(0, options.limit)
        : quarantineRows;
    // Advance while rows remain; reset on drain so a quarantined row that
    // appears behind the watermark is picked up by the next pass.
    const nextNullGuid = quarantineHasMore
        ? quarantinePage[quarantinePage.length - 1].guid
        : null;
    const quarantinedGuids = new Set(quarantinePage.map(row => row.guid));

    const hasMore = orderedHasMore || quarantineHasMore;

    const delivered = [...page, ...quarantinePage];
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
            ...(quarantinedGuids.has(row.guid) ? { quarantined: true as const } : {}),
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

    // Each stream advances its own part of the cursor.
    //
    // The HIGH WATERMARK is the greatest position ever sent, so it takes the
    // max of what the client already held and the last row on this page — a
    // sweep that restarted below the watermark emits rows underneath it, and
    // letting those rewind the watermark would drag the next sweep's floor down
    // with them, one poll at a time, forever. An empty page leaves it alone,
    // which is also what keeps a client from being reset to the beginning of
    // the feed when there is simply nothing new.
    const last = page[page.length - 1];
    const held = { enterDate: cursor?.enterDate ?? null, guid: cursor?.guid ?? null };
    const seen = last && last.enter_date ? { enterDate: last.enter_date, guid: last.guid } : null;
    const position = seen && isAfter(seen, held) ? seen : held;

    // The SWEEP POSITION advances while the pass has more to read and clears
    // when it drains — the clear is what makes the NEXT generation start from
    // `sweepBase - BEEZ_FEED_OVERLAP` and pick up late-landing writes. Keeping
    // it while `hasMore` is what makes each generation terminate.
    const nextSweep = orderedHasMore && seen ? seen : null;

    // The SWEEP BASE rides through unchanged either way. Mid-generation it is
    // this generation's own pin; on the page that drains it becomes the floor
    // the NEXT generation measures down from — the base this generation began
    // with, deliberately NOT the watermark it ended on. A generation that ran
    // for hours and finished on a far-future row would otherwise hoist the next
    // floor above rows written while it was still reading, and those rows would
    // never be delivered. Handing the base forward instead keeps one complete
    // overlap generation of history in the floor at all times.
    const nextCursorBase = generationBase;

    // Nothing to name in any stream — an empty book — so the client starts
    // from the beginning next time, which is where it already is.
    const nextCursor = position.enterDate !== null || nextNullGuid !== null
        ? encodeChangesCursor({
            ...position,
            nullGuid: nextNullGuid,
            sweepEnterDate: nextSweep?.enterDate ?? null,
            sweepGuid: nextSweep?.guid ?? null,
            sweepBase: nextCursorBase,
        })
        : null;

    return { items, nextCursor, hasMore };
}

/**
 * The database clock, rendered in {@link ENTER_DATE_PG_FORMAT}.
 *
 * It is the sweep base for a generation that begins with no high watermark: a
 * brand new client, or one still only part-way through the quarantine set.
 * Without it such a generation would have no floor to hand its successor and
 * the successor would have to re-scan the whole ledger to stay honest.
 *
 * The DATABASE clock, not `new Date()`, for the same reason every other writer
 * on this column reads it there: the app host and the database are different
 * machines, and a base derived from the wrong one would be off by their skew in
 * a comparison that is supposed to bound exactly that. `AT TIME ZONE 'UTC'`
 * matches the scale `enter_date` is stored on.
 */
async function readDatabaseClockStamp(): Promise<string> {
    const rows = await prisma.$queryRaw<Array<{ stamp: string }>>`
        SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC'), ${ENTER_DATE_PG_FORMAT}::text) AS stamp
    `;
    return rows[0].stamp;
}

/**
 * `a > b` in the feed's `(enter_date, guid)` order, for positions already
 * rendered in {@link ENTER_DATE_PG_FORMAT}.
 *
 * String comparison is exact here and NOT a shortcut: the format is fixed-width
 * and zero-padded from the most significant field down, so lexicographic order
 * IS chronological order. Parsing to a `Date` to compare would throw the
 * microseconds away, which is the one thing this cursor exists to keep.
 */
function isAfter(
    a: { enterDate: string; guid: string },
    b: { enterDate: string | null; guid: string | null },
): boolean {
    if (b.enterDate === null || b.guid === null) return true;
    if (a.enterDate !== b.enterDate) return a.enterDate > b.enterDate;
    return a.guid > b.guid;
}

// ---------------------------------------------------------------------------
// Verify (read-only)
// ---------------------------------------------------------------------------

/**
 * What an external id resolves to, right now, in this book.
 *
 *  - `linked` — the link exists and so does its transaction. The item carries
 *    the whole ledger entry so the caller can compare it field by field.
 *  - `no-link` — this book has never linked that id, or the link was removed.
 *    Nothing to compare against.
 *  - `orphan-link` — the link exists but its transaction is gone. This is the
 *    tombstone the change feed reports, seen from the other side, and it is a
 *    DIFFERENT fact from `no-link`: the mapping survived and the ledger entry
 *    did not, so the repair is DELETE to acknowledge, not POST to recreate.
 */
export type BeezVerifyState = 'linked' | 'no-link' | 'orphan-link';

export interface BeezVerifySplit {
    accountGuid: string;
    amountCents: number;
    memo: string;
}

/**
 * One id's answer. Everything past `state` is present only for `linked`, except
 * `transactionGuid`, which an `orphan-link` also carries — it names the row the
 * link still points at, which is what a repair tool needs in order to say what
 * went missing.
 */
export interface BeezVerifyItem {
    externalId: string;
    state: BeezVerifyState;
    transactionGuid?: string;
    enterDate?: string | null;
    postDate?: string | null;
    description?: string | null;
    num?: string | null;
    splits?: BeezVerifySplit[];
    /**
     * Set when at least one split cannot be stated exactly in cents; `splits`
     * is then empty, exactly as in the change feed. A verifier must treat this
     * as "cannot compare", never as "the amounts differ" — see the cents
     * discipline in src/lib/integrations/beez.ts.
     */
    unrepresentable?: true;
    /**
     * True when any split is reconciled ('y') or frozen ('f'). Such a
     * transaction cannot be corrected through this API at all: PUT and DELETE
     * refuse it with 409. A caller that finds a divergence here knows to raise
     * it with a human rather than to queue a repair that will bounce.
     */
    reconciledOrFrozen?: boolean;
    /**
     * True when the post date falls on or before the book's period lock date —
     * the same rule `assertNotLocked` enforces on every write. Also
     * uncorrectable remotely, for a different reason: the period was closed
     * with these figures in it.
     */
    inClosedPeriod?: boolean;
}

interface VerifyTxRow {
    guid: string;
    post_date: Date | null;
    num: string | null;
    description: string | null;
    /** The database's own microsecond rendering — see {@link ChangeTxRow}. */
    enter_date: string | null;
}

/**
 * Resolve external ids to what they currently point at. READS ONLY.
 *
 * This is the read half of the restore story: after beez-trackz restores its
 * own external-id mappings from a portable snapshot, it must prove every
 * restored id still resolves to the transaction it expects BEFORE sync is
 * re-enabled — because the first thing a re-enabled sync would otherwise do is
 * push its idea of the truth over folio's. So this function writes nothing at
 * all: no idempotency claim, no `enter_date` bump, no link mutation, no audit
 * row. There is deliberately no verb here that could repair anything; a caller
 * that finds a divergence uses the existing write endpoints, one at a time,
 * with a human in the loop.
 *
 * ONE PASS, NOT ONE PASS PER ID. Four queries answer the whole batch — links,
 * transactions, splits, and the book's lock date — so a 500-id verification
 * costs the same round trips as a 1-id one. The shape follows the change feed's
 * fan-out (`= ANY(...::text[])`, then group in memory) rather than a loop of
 * `findLinkByExternalId`, which would be 1500 round trips for the same answer.
 *
 * BOOK SCOPING is the link query's `book_guid` predicate and nothing else,
 * which is sound for exactly the reason {@link findLinkByExternalId} documents:
 * the POST path is the only writer of that table, so a link row under this book
 * always names a transaction in this book. Re-deriving book membership from the
 * splits would be a second, weaker spelling of an invariant the unique index
 * already holds.
 *
 * The results are returned in REQUEST ORDER, one per requested entry including
 * repeats, so the caller can zip its own list against them by index.
 */
export async function verifyBeezExternalIds(
    context: BeezBookContext,
    externalIds: string[],
): Promise<BeezVerifyItem[]> {
    if (externalIds.length === 0) return [];

    const uniqueIds = [...new Set(externalIds)];
    const links = await prisma.$queryRaw<LinkRow[]>`
        SELECT external_id, entity_guid
        FROM gnucash_web_external_links
        WHERE book_guid = ${context.bookGuid} AND source = ${BEEZ_SOURCE}
          AND entity_type = 'transaction'
          AND external_id = ANY(${uniqueIds}::text[])
    `;
    const entityByExternalId = new Map(links.map(row => [row.external_id, row.entity_guid]));
    const txGuids = [...new Set(links.map(row => row.entity_guid))];

    // The lock date is read ONCE for the batch, through the ordinary cached
    // reader rather than the `bypassCache` path the writers use. This call
    // takes no locks and changes nothing, so a lock date set in the last second
    // costs at worst one stale `inClosedPeriod` flag on a report a human is
    // going to act on — where the writers' checks must bypass the cache
    // because a stale read there would let a write into a closed period.
    const [txRows, splitRows, lockDate] = await Promise.all([
        txGuids.length > 0
            ? prisma.$queryRaw<VerifyTxRow[]>`
                SELECT guid, post_date, num, description,
                       to_char(enter_date, ${ENTER_DATE_PG_FORMAT}::text) AS enter_date
                FROM transactions WHERE guid = ANY(${txGuids}::text[])
            `
            : Promise.resolve([] as VerifyTxRow[]),
        txGuids.length > 0
            ? prisma.$queryRaw<ChangeSplitRow[]>`
                SELECT tx_guid, account_guid, memo, reconcile_state, value_num, value_denom
                FROM splits WHERE tx_guid = ANY(${txGuids}::text[])
                ORDER BY tx_guid, guid
            `
            : Promise.resolve([] as ChangeSplitRow[]),
        getCachedLockDate(context.bookGuid),
    ]);

    const txByGuid = new Map(txRows.map(row => [row.guid, row]));
    const splitsByTx = new Map<string, ChangeSplitRow[]>();
    for (const split of splitRows) {
        const bucket = splitsByTx.get(split.tx_guid);
        if (bucket) bucket.push(split);
        else splitsByTx.set(split.tx_guid, [split]);
    }

    return externalIds.map((externalId): BeezVerifyItem => {
        const entityGuid = entityByExternalId.get(externalId);
        if (entityGuid === undefined) {
            return { externalId, state: 'no-link' };
        }

        const transaction = txByGuid.get(entityGuid);
        if (!transaction) {
            return { externalId, state: 'orphan-link', transactionGuid: entityGuid };
        }

        const rawSplits = splitsByTx.get(entityGuid) ?? [];
        const converted = rawSplits.map(split => ({
            split,
            cents: splitValueToCents(split.value_num, split.value_denom),
        }));

        const base: BeezVerifyItem = {
            externalId,
            state: 'linked',
            transactionGuid: transaction.guid,
            // The raw database rendering with the UTC marker the column's
            // convention implies — byte-identical to the change feed's, so a
            // client can compare the two without normalizing either. A Date
            // round trip would truncate the microseconds and make a row that
            // never changed look as though it had.
            enterDate: transaction.enter_date ? `${transaction.enter_date}Z` : null,
            postDate: timestampToPostDate(transaction.post_date),
            description: transaction.description,
            num: transaction.num,
            // The codebase-wide meaning of "pinned to a statement", not a local
            // `=== 'y'`: 'f' is the state that got missed the first time a
            // second spelling of this rule was written.
            reconciledOrFrozen: rawSplits.some(
                split => isProtectedReconcileState(split.reconcile_state),
            ),
            inClosedPeriod: findLockedDate(lockDate, [transaction.post_date]) !== null,
        };

        // All-or-nothing, as in the change feed: one 1/3 split makes the whole
        // transaction incomparable rather than partially comparable. Rounding
        // it into cents would invent money and, here, would manufacture a
        // divergence — or hide one.
        if (converted.some(entry => entry.cents === null)) {
            return { ...base, splits: [], unrepresentable: true };
        }

        return {
            ...base,
            splits: converted.map(entry => ({
                accountGuid: entry.split.account_guid,
                amountCents: entry.cents as number,
                memo: entry.split.memo ?? '',
            })),
        };
    });
}

/**
 * One external id's current state, for `GET .../transactions/{externalId}`.
 *
 * Implemented ON TOP of the batch so the two endpoints cannot drift: the single
 * lookup is a batch of one, and every field, flag, and edge case is computed by
 * the same code. The only difference is at the edge — `no-link` is a 404 here,
 * because a caller that asked about one id by name is asking whether it exists,
 * whereas a batch caller is asking what each of its ids is, and one absent id
 * must not fail the other 499.
 */
export async function getBeezTransactionByExternalId(
    context: BeezBookContext,
    externalId: string,
): Promise<BeezVerifyItem> {
    const [item] = await verifyBeezExternalIds(context, [externalId]);
    if (!item || item.state === 'no-link') {
        throw new BeezSyncError(
            404, 'unknown_external_id', `No folio transaction is linked to "${externalId}"`,
        );
    }
    return item;
}
