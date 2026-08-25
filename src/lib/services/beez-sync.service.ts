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
 *  - **Reconciled work is not ours to move.** A split marked 'y' is pinned to a
 *    bank statement; replacing or deleting it silently would break an agreement
 *    a human made.
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
async function findLinkByExternalId(bookGuid: string, externalId: string): Promise<LinkRow | null> {
    const row = await prisma.gnucash_web_external_links.findUnique({
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
    enterDate: string;
    externalId: string;
    alreadyLinked?: true;
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
 * The link check runs FIRST, so a well-behaved client — one key per record —
 * only ever sees the second mechanism; the key path is what catches a retry
 * that arrives while the first attempt is still in flight.
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

    const existing = await findLinkByExternalId(context.bookGuid, externalId);
    if (existing) {
        return { result: await describeExistingLink(context, existing), status: 200 };
    }

    await assertAccountsUsable(context, input.splits.map(split => split.accountGuid));

    const txGuid = generateGuid();
    const postDate = postDateToTimestamp(input.postDate);
    const enterDate = new Date();

    let written: BeezCreateResult;
    try {
        const outcome = await withIdempotency(
            context.bookGuid,
            'beez-transaction-create',
            idempotencyKey,
            async (database) => {
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
                        enter_date: enterDate,
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

                return {
                    transactionGuid: txGuid,
                    enterDate: enterDate.toISOString(),
                    externalId,
                } satisfies BeezCreateResult;
            },
        );

        if (outcome.replayed) {
            // The stored 201 body, marked so the caller can tell a replay from
            // a fresh write without inspecting the status code alone.
            return {
                result: { ...(outcome.result as BeezCreateResult), alreadyLinked: true },
                status: 200,
            };
        }
        written = outcome.result;
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

    await recordAndInvalidate(
        context, actor, 'CREATE', txGuid, null, auditSnapshot(externalId, input), [postDate],
    );

    return { result: written, status: 201 };
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
): Promise<BeezCreateResult> {
    const transaction = await prisma.transactions.findUnique({
        where: { guid: link.entity_guid },
        select: { guid: true, enter_date: true },
    });
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
        enterDate: (transaction.enter_date ?? new Date(0)).toISOString(),
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
 */
export async function replaceBeezTransaction(
    context: BeezBookContext,
    actor: Actor,
    externalId: string,
    input: BeezTransactionInput,
    idempotencyKey: IdempotencyKey,
): Promise<BeezReplaceResult> {
    const link = await findLinkByExternalId(context.bookGuid, externalId);
    if (!link) {
        throw new BeezSyncError(404, 'unknown_external_id', `No folio transaction is linked to "${externalId}"`);
    }

    await assertAccountsUsable(context, input.splits.map(split => split.accountGuid));

    const txGuid = link.entity_guid;
    const postDate = postDateToTimestamp(input.postDate);
    const enterDate = new Date();
    let previousPostDate: Date | null = null;

    const outcome = await withIdempotency(
        context.bookGuid,
        'beez-transaction-update',
        idempotencyKey,
        async (database) => {
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
                select: { guid: true, reconcile_state: true },
            });
            // Read inside the transaction on the locked row, so a reconcile
            // committed a millisecond ago cannot slip past this guard.
            if (existingSplits.some(split => split.reconcile_state === 'y')) {
                throw new BeezSyncError(
                    409,
                    'reconciled',
                    'This transaction has reconciled splits and cannot be replaced from beez',
                );
            }

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
                    // Always a fresh timestamp: it is both the change-feed
                    // ordering key and every other writer's version token.
                    enter_date: enterDate,
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

            return {
                transactionGuid: txGuid,
                enterDate: enterDate.toISOString(),
            } satisfies BeezReplaceResult;
        },
    );

    if (outcome.replayed) return outcome.result as BeezReplaceResult;

    await recordAndInvalidate(
        context, actor, 'UPDATE', txGuid, { external_id: externalId }, auditSnapshot(externalId, input),
        [postDate, previousPostDate],
    );
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
 */
export async function deleteBeezTransaction(
    context: BeezBookContext,
    actor: Actor,
    externalId: string,
    idempotencyKey: IdempotencyKey,
): Promise<BeezDeleteResult> {
    const link = await findLinkByExternalId(context.bookGuid, externalId);
    if (!link) {
        throw new BeezSyncError(404, 'unknown_external_id', `No folio transaction is linked to "${externalId}"`);
    }

    const txGuid = link.entity_guid;
    let deletedPostDate: Date | null = null;
    let wasOrphan = false;

    const outcome = await withIdempotency(
        context.bookGuid,
        'beez-transaction-delete',
        idempotencyKey,
        async (database) => {
            const locked = await database.$queryRaw<Array<{ guid: string; post_date: Date | null }>>`
                SELECT guid, post_date FROM transactions WHERE guid = ${txGuid} FOR UPDATE
            `;

            if (locked.length > 0) {
                deletedPostDate = locked[0].post_date;

                const existingSplits = await database.splits.findMany({
                    where: { tx_guid: txGuid },
                    select: { guid: true, reconcile_state: true },
                });
                if (existingSplits.some(split => split.reconcile_state === 'y')) {
                    throw new BeezSyncError(
                        409,
                        'reconciled',
                        'This transaction has reconciled splits and cannot be deleted from beez',
                    );
                }

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

    if (!wasOrphan) {
        await recordAndInvalidate(
            context, actor, 'DELETE', txGuid,
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

interface ChangeTxRow {
    guid: string;
    post_date: Date | null;
    enter_date: Date | null;
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
 * Transactions entered after the cursor, oldest first, plus tombstones.
 *
 * ORDERING. `(enter_date, guid)` is the only total order that stays stable
 * while rows are being written: post_date has ties and moves backwards on an
 * edit, and `guid` breaks the remaining ties deterministically. Rows whose
 * `enter_date` is NULL — GnuCash permits it — sort last, matching PostgreSQL's
 * default NULLS LAST for the ascending index this pages on, so they are
 * delivered rather than silently dropped from the feed forever.
 *
 * TOMBSTONES. A link row whose transaction is gone is emitted as
 * `{ externalId, deleted: true }` on EVERY page until beez acknowledges it with
 * DELETE. They live outside the enter_date ordering (a deleted row has no
 * enter_date to sort by), so there is nowhere in the cursor stream to put them;
 * repeating a bounded, self-draining set is the honest alternative to inventing
 * a position for it. They do not count towards `limit` for the transaction page
 * and never advance `nextCursor`.
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

    let afterCursor: Prisma.Sql;
    if (!cursor) {
        afterCursor = Prisma.sql`TRUE`;
    } else if (cursor.enterDate === null) {
        // Already inside the NULL-enter_date tail: only later guids remain.
        afterCursor = Prisma.sql`(t.enter_date IS NULL AND t.guid > ${cursor.guid})`;
    } else {
        afterCursor = Prisma.sql`(
            (t.enter_date IS NOT NULL AND (t.enter_date, t.guid) > (${new Date(cursor.enterDate)}, ${cursor.guid}))
            OR t.enter_date IS NULL
        )`;
    }

    // One extra row is the cheapest honest hasMore: it answers "is there a
    // next page?" without a second COUNT over the same predicate.
    const rows = await prisma.$queryRaw<ChangeTxRow[]>`
        SELECT t.guid, t.post_date, t.enter_date, t.description
        FROM transactions t
        WHERE ${inBook} AND ${afterCursor}
        ORDER BY (t.enter_date IS NULL) ASC, t.enter_date ASC, t.guid ASC
        LIMIT ${options.limit + 1}
    `;
    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;

    const guids = page.map(row => row.guid);
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

    const items: BeezChangeItem[] = page.map((row) => {
        const rawSplits = splitsByTx.get(row.guid) ?? [];
        const converted = rawSplits.map(split => ({
            split,
            cents: splitValueToCents(split.value_num, split.value_denom),
        }));

        const base: BeezChangeItem = {
            transactionGuid: row.guid,
            externalId: externalIdByTx.get(row.guid) ?? null,
            postDate: timestampToPostDate(row.post_date),
            enterDate: row.enter_date ? row.enter_date.toISOString() : null,
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

    const last = page[page.length - 1];
    const nextCursor = last
        ? encodeChangesCursor({
            enterDate: last.enter_date ? last.enter_date.toISOString() : null,
            guid: last.guid,
        })
        // An empty page must not reset the client to the beginning of the feed:
        // hand back the cursor it sent, so the next poll resumes where it was.
        : (options.since || null);

    return { items, nextCursor, hasMore };
}
