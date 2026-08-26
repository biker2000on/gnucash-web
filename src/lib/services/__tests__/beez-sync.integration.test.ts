/**
 * beez-trackz sync, end to end against a REAL PostgreSQL server.
 *
 * What needs a database and cannot be faked:
 *   - the UNIQUE index on (book_guid, source, external_id) is what makes a
 *     replayed POST a no-op. A mocked client can only prove a string was
 *     passed to a spy; it cannot prove the second insert loses.
 *   - the idempotency claim/complete/release lifecycle, which is three
 *     statements inside one transaction with a fence token.
 *   - the change feed's `(enter_date, guid)` paging, tombstones, and the
 *     unrepresentable-split rule, all of which are SQL.
 *   - the reconciled-split and period-lock guards, which read committed state
 *     inside the write transaction.
 *
 * DATA. This tier never truncates (see vitest.integration.config.ts). Every row
 * written here carries this run's uuid in its guid or a run-scoped column, and
 * afterAll deletes exactly those rows.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTestPool } from '../../../__tests__/integration/db';
import { hasTestDatabaseUrl } from '../../../__tests__/integration/env';

const HAS_TEST_DATABASE = hasTestDatabaseUrl();

/** Distinguishes this run's rows from any left behind by another run. */
const RUN_ID = randomUUID().replace(/-/g, '');

/** GnuCash guid columns are VARCHAR(32); a dash-stripped uuid is exactly 32. */
function testGuid(): string {
    return randomUUID().replace(/-/g, '');
}

const BOOK_GUID = testGuid();
const ROOT_GUID = testGuid();
const TEMPLATE_ROOT_GUID = testGuid();
const USD_GUID = testGuid();
const EUR_GUID = testGuid();
const CHECKING_GUID = testGuid();
const EXPENSE_GUID = testGuid();
const PLACEHOLDER_GUID = testGuid();
const FOREIGN_GUID = testGuid();

/** A second book, used to prove account scoping refuses foreign guids. */
const OTHER_BOOK_GUID = testGuid();
const OTHER_ROOT_GUID = testGuid();
const OTHER_ACCOUNT_GUID = testGuid();

const USERNAME = `beez-test-${RUN_ID.slice(0, 12)}`;
let userId = 0;

/** Lazily imported so nothing in src/lib is evaluated when the suite skips. */
let service: typeof import('../beez-sync.service');
let bookScope: typeof import('@/lib/book-scope');
let beez: typeof import('@/lib/integrations/beez');
/**
 * The shared enter_date stamper. Every feed-visible writer in the app goes
 * through it — the beez mutations, `PUT /api/transactions/[guid]`, the bulk
 * edit, and the reconcile/lot split paths — so calling it directly here
 * exercises the EXACT statement those routes issue. Driving the Next route
 * handlers themselves is not possible from this tier (they need a request
 * scope, auth, and the book-scope cache); what the routes are separately held
 * to is that they issue this statement and no `new Date()` literal, which their
 * own route tests assert.
 */
let enterDate: typeof import('@/lib/enter-date');
let db: typeof import('@/lib/prisma').default;
let context: import('../beez-sync.service').BeezBookContext;

/** Two-split body helper: money out of checking into an expense. */
function body(externalId: string | null, cents: number, overrides: Record<string, unknown> = {}) {
    return {
        // Omitted entirely on a replace body — the PUT contract rejects the
        // field rather than ignoring it, because the path names the record.
        ...(externalId === null ? {} : { externalId }),
        postDate: '2026-08-25',
        description: 'Hive inspection supplies',
        num: '',
        splits: [
            { accountGuid: EXPENSE_GUID, amountCents: cents, memo: 'supplies' },
            { accountGuid: CHECKING_GUID, amountCents: -cents, memo: '' },
        ],
        ...overrides,
    };
}

function parsed(externalId: string | null, cents: number, overrides: Record<string, unknown> = {}) {
    const result = beez.parseBeezTransactionInput(
        body(externalId, cents, overrides),
        { requireExternalId: externalId !== null },
    );
    if (!result.ok) throw new Error(`fixture body failed validation: ${result.detail}`);
    return result.data;
}

const actor = () => ({ userId });

/** A balanced two-split pair on this run's accounts, written straight to SQL. */
async function insertBalancedSplits(txGuid: string, cents: number): Promise<void> {
    await getTestPool().query(
        `INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state,
                             value_num, value_denom, quantity_num, quantity_denom)
         VALUES ($1, $3, $4, '', '', 'n', $6, 100, $6, 100),
                ($2, $3, $5, '', '', 'n', -$6, 100, -$6, 100)`,
        [testGuid(), testGuid(), txGuid, EXPENSE_GUID, CHECKING_GUID, cents],
    );
}

/**
 * A transaction with `enter_date IS NULL`. GnuCash permits it and the desktop
 * client writes them, so the feed has to carry them; it cannot be done through
 * the service, which always stamps one.
 */
async function insertNullEnterDateTransaction(description: string): Promise<string> {
    const txGuid = testGuid();
    await getTestPool().query(
        `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
         VALUES ($1, $2, '', NOW(), NULL, $3)`,
        [txGuid, USD_GUID, description],
    );
    await insertBalancedSplits(txGuid, 100);
    return txGuid;
}

/** Remove a hand-written transaction so it cannot perturb later assertions. */
async function dropTransaction(txGuid: string): Promise<void> {
    const pool = getTestPool();
    await pool.query(`DELETE FROM splits WHERE tx_guid = $1`, [txGuid]);
    await pool.query(`DELETE FROM transactions WHERE guid = $1`, [txGuid]);
}

async function seed(): Promise<void> {
    const pool = getTestPool();

    const user = await pool.query<{ id: number }>(
        `INSERT INTO gnucash_web_users (username, password_hash) VALUES ($1, $2) RETURNING id`,
        [USERNAME, 'not-a-real-hash'],
    );
    userId = user.rows[0].id;

    await pool.query(
        `INSERT INTO commodities (guid, namespace, mnemonic, fullname, fraction, quote_flag)
         VALUES ($1, 'CURRENCY', $2, 'US Dollar', 100, 0), ($3, 'CURRENCY', $4, 'Euro', 100, 0)`,
        // Mnemonics carry the run id so two concurrent runs cannot collide on
        // the uq_commodities_namespace_mnemonic index db-init creates.
        [USD_GUID, `U${RUN_ID.slice(0, 6)}`, EUR_GUID, `E${RUN_ID.slice(0, 6)}`],
    );

    const account = async (
        guid: string, name: string, type: string, parent: string | null,
        commodity: string, placeholder = 0,
    ) => pool.query(
        `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu,
                               non_std_scu, parent_guid, placeholder, hidden)
         VALUES ($1, $2, $3, $4, 100, 0, $5, $6, 0)`,
        [guid, name, type, commodity, parent, placeholder],
    );

    await account(ROOT_GUID, `Root ${RUN_ID.slice(0, 8)}`, 'ROOT', null, USD_GUID);
    await account(TEMPLATE_ROOT_GUID, 'Template Root', 'ROOT', null, USD_GUID);
    await account(CHECKING_GUID, 'Checking', 'BANK', ROOT_GUID, USD_GUID);
    await account(PLACEHOLDER_GUID, 'Expenses', 'EXPENSE', ROOT_GUID, USD_GUID, 1);
    await account(EXPENSE_GUID, 'Bee Supplies', 'EXPENSE', PLACEHOLDER_GUID, USD_GUID);
    await account(FOREIGN_GUID, 'Euro Cash', 'ASSET', ROOT_GUID, EUR_GUID);

    await account(OTHER_ROOT_GUID, `Other Root ${RUN_ID.slice(0, 8)}`, 'ROOT', null, USD_GUID);
    await account(OTHER_ACCOUNT_GUID, 'Other Checking', 'BANK', OTHER_ROOT_GUID, USD_GUID);

    await pool.query(
        `INSERT INTO books (guid, root_account_guid, root_template_guid, name)
         VALUES ($1, $2, $3, $4), ($5, $6, $3, $7)`,
        [
            BOOK_GUID, ROOT_GUID, TEMPLATE_ROOT_GUID, `Beez Test ${RUN_ID.slice(0, 8)}`,
            OTHER_BOOK_GUID, OTHER_ROOT_GUID, `Beez Other ${RUN_ID.slice(0, 8)}`,
        ],
    );
}

/**
 * Deletes exactly this run's rows, children first. Every statement is scoped by
 * a guid minted in this file, so a mistyped TEST_DATABASE_URL destroys nothing.
 */
async function cleanup(): Promise<void> {
    const pool = getTestPool();
    const accountGuids = [
        CHECKING_GUID, EXPENSE_GUID, PLACEHOLDER_GUID, FOREIGN_GUID,
        OTHER_ACCOUNT_GUID, ROOT_GUID, TEMPLATE_ROOT_GUID, OTHER_ROOT_GUID,
    ];
    const bookGuids = [BOOK_GUID, OTHER_BOOK_GUID];

    await pool.query(
        `DELETE FROM slots WHERE obj_guid IN (
             SELECT guid FROM splits WHERE account_guid = ANY($1::text[])
             UNION SELECT tx_guid FROM splits WHERE account_guid = ANY($1::text[]))`,
        [accountGuids],
    );
    await pool.query(
        `DELETE FROM gnucash_web_transaction_meta WHERE transaction_guid IN (
             SELECT tx_guid FROM splits WHERE account_guid = ANY($1::text[]))`,
        [accountGuids],
    );
    await pool.query(
        `DELETE FROM transactions WHERE guid IN (
             SELECT tx_guid FROM splits WHERE account_guid = ANY($1::text[]))`,
        [accountGuids],
    );
    await pool.query(`DELETE FROM splits WHERE account_guid = ANY($1::text[])`, [accountGuids]);
    await pool.query(`DELETE FROM gnucash_web_external_links WHERE book_guid = ANY($1::text[])`, [bookGuids]);
    await pool.query(`DELETE FROM gnucash_web_webhook_idempotency WHERE book_guid = ANY($1::text[])`, [bookGuids]);
    await pool.query(`DELETE FROM gnucash_web_audit WHERE book_guid = ANY($1::text[])`, [bookGuids]);
    await pool.query(`DELETE FROM books WHERE guid = ANY($1::text[])`, [bookGuids]);
    await pool.query(`DELETE FROM accounts WHERE guid = ANY($1::text[])`, [accountGuids]);
    await pool.query(`DELETE FROM commodities WHERE guid = ANY($1::text[])`, [[USD_GUID, EUR_GUID]]);
    await pool.query(`DELETE FROM gnucash_web_users WHERE username = $1`, [USERNAME]);
}

/** The book-scope module memoizes account guids for ~3s; seeding invalidates it. */
function refreshBookScope(): void {
    bookScope.invalidateBookAccountGuidsCache();
}

/**
 * Poll one complete SWEEP: from `from` until `hasMore` goes false, which is
 * where the ordered stream drains and the next sweep would rewind by the
 * overlap.
 *
 * Within a sweep the feed is strictly forward — that is the property worth
 * asserting, and the one the overlap must not have cost. The 60-poll ceiling
 * turns a stalled sweep into a failed assertion instead of a hung suite.
 */
async function sweepFrom(
    from: string | null,
    limit: number,
): Promise<{ ordered: string[]; cursor: string | null; polls: number }> {
    const ordered: string[] = [];
    let cursor = from;
    let polls = 0;
    while (polls < 60) {
        const response = await service.getBeezChanges(context, { since: cursor, limit });
        // The always-emitted sets ride along on every page and are identified
        // by the quarantined/deleted flags; only the ordered stream is bounded
        // by `limit` and only it is the sweep.
        ordered.push(
            ...response.items
                .filter(item => !item.deleted && !item.quarantined)
                .map(item => item.transactionGuid as string),
        );
        cursor = response.nextCursor;
        polls += 1;
        if (!response.hasMore) return { ordered, cursor, polls };
    }
    throw new Error('sweep did not drain within 60 polls');
}

describe.skipIf(!HAS_TEST_DATABASE)('beez-trackz sync round trip', () => {
    beforeAll(async () => {
        service = await import('../beez-sync.service');
        bookScope = await import('@/lib/book-scope');
        beez = await import('@/lib/integrations/beez');
        enterDate = await import('@/lib/enter-date');
        db = (await import('@/lib/prisma')).default;
        await seed();
        refreshBookScope();
        context = await service.getBeezBookContext(BOOK_GUID);
    });

    afterAll(async () => {
        await cleanup();
    });

    it('resolves the book context from the token book alone', () => {
        expect(context.bookGuid).toBe(BOOK_GUID);
        expect(context.rootAccountGuid).toBe(ROOT_GUID);
        expect(context.rootCommodityGuid).toBe(USD_GUID);
        expect(context.bookName).toContain('Beez Test');
    });

    it('lists the book chart of accounts with root-relative paths', async () => {
        const accounts = await service.listBeezAccounts(context);
        const byGuid = new Map(accounts.map(account => [account.guid, account]));

        // The root itself is not part of the path, and a nested account shows
        // its whole branch.
        expect(byGuid.get(EXPENSE_GUID)?.fullName).toBe('Expenses:Bee Supplies');
        expect(byGuid.get(CHECKING_GUID)?.fullName).toBe('Checking');
        expect(byGuid.get(PLACEHOLDER_GUID)?.placeholder).toBe(true);
        expect(byGuid.get(CHECKING_GUID)?.placeholder).toBe(false);
        expect(byGuid.get(FOREIGN_GUID)?.commodityMnemonic).toBe(`E${RUN_ID.slice(0, 6)}`);

        // Another book's accounts are not this book's business.
        expect(byGuid.has(OTHER_ACCOUNT_GUID)).toBe(false);
        expect(byGuid.has(ROOT_GUID)).toBe(false);
    });

    describe('create', () => {
        const externalId = `${RUN_ID}-create`;
        let created: { transactionGuid: string; enterDate: string | null };

        it('writes the transaction, its splits, meta, and the link in one commit', async () => {
            const outcome = await service.createBeezTransaction(
                context, actor(), parsed(externalId, 1250), null,
            );
            expect(outcome.status).toBe(201);
            expect(outcome.result.externalId).toBe(externalId);
            created = outcome.result;

            const pool = getTestPool();
            const splits = await pool.query<{
                account_guid: string; value_num: string; value_denom: string;
                quantity_num: string; quantity_denom: string; memo: string; reconcile_state: string;
            }>(
                `SELECT account_guid, value_num::text, value_denom::text,
                        quantity_num::text, quantity_denom::text, memo, reconcile_state
                 FROM splits WHERE tx_guid = $1 ORDER BY value_num DESC`,
                [created.transactionGuid],
            );
            expect(splits.rowCount).toBe(2);
            // Exact cents/100 — no decimal string was parsed and nothing was
            // rounded, and quantity mirrors value because v1 is currency-only.
            expect(splits.rows[0]).toMatchObject({
                account_guid: EXPENSE_GUID,
                value_num: '1250', value_denom: '100',
                quantity_num: '1250', quantity_denom: '100',
                memo: 'supplies', reconcile_state: 'n',
            });
            expect(splits.rows[1].value_num).toBe('-1250');

            const meta = await pool.query<{ source: string; reviewed: boolean }>(
                `SELECT source, reviewed FROM gnucash_web_transaction_meta WHERE transaction_guid = $1`,
                [created.transactionGuid],
            );
            expect(meta.rows[0]).toEqual({ source: 'beez-trackz', reviewed: true });

            const link = await pool.query(
                `SELECT entity_guid FROM gnucash_web_external_links
                 WHERE book_guid = $1 AND source = 'beez-trackz' AND external_id = $2`,
                [BOOK_GUID, externalId],
            );
            expect(link.rows[0].entity_guid).toBe(created.transactionGuid);
        });

        it('records an audit row, because evidence is part of the result', async () => {
            const audit = await getTestPool().query<{ action: string; new_values: unknown }>(
                `SELECT action, new_values FROM gnucash_web_audit
                 WHERE book_guid = $1 AND entity_guid = $2 AND action = 'CREATE'`,
                [BOOK_GUID, created.transactionGuid],
            );
            expect(audit.rowCount).toBe(1);
            expect(audit.rows[0].new_values).toMatchObject({
                source: 'beez-trackz',
                external_id: externalId,
            });
        });

        it('answers a replay from the link instead of writing a second entry', async () => {
            const replay = await service.createBeezTransaction(
                context, actor(), parsed(externalId, 9999), null,
            );
            expect(replay.status).toBe(200);
            expect(replay.result.alreadyLinked).toBe(true);
            expect(replay.result.transactionGuid).toBe(created.transactionGuid);

            // The replay's different amount must NOT have been applied — POST is
            // create-or-nothing, never create-or-update.
            const count = await getTestPool().query<{ n: string }>(
                `SELECT count(*)::text AS n FROM splits WHERE account_guid = $1 AND value_num = 9999`,
                [EXPENSE_GUID],
            );
            expect(count.rows[0].n).toBe('0');
        });

        it('replays an interrupted request from its stored Idempotency-Key result', async () => {
            const key = `${RUN_ID}-key-1`;
            const id = `${RUN_ID}-idem`;
            const first = await service.createBeezTransaction(context, actor(), parsed(id, 500), key);
            expect(first.status).toBe(201);

            // Same key, DIFFERENT external id: the stored result wins, proving
            // the key short-circuits before any of the body is looked at.
            const second = await service.createBeezTransaction(
                context, actor(), parsed(`${RUN_ID}-idem-other`, 700), key,
            );
            expect(second.status).toBe(200);
            expect(second.result.transactionGuid).toBe(first.result.transactionGuid);
            expect(second.result.alreadyLinked).toBe(true);

            const links = await getTestPool().query<{ n: string }>(
                `SELECT count(*)::text AS n FROM gnucash_web_external_links
                 WHERE book_guid = $1 AND external_id = $2`,
                [BOOK_GUID, `${RUN_ID}-idem-other`],
            );
            expect(links.rows[0].n).toBe('0');
        });

        it('refuses an account from another book with the same 404 as a missing one', async () => {
            const input = parsed(`${RUN_ID}-foreign`, 100, {
                splits: [
                    { accountGuid: OTHER_ACCOUNT_GUID, amountCents: 100 },
                    { accountGuid: CHECKING_GUID, amountCents: -100 },
                ],
            });
            await expect(service.createBeezTransaction(context, actor(), input, null))
                .rejects.toMatchObject({ status: 404, code: 'account_not_found' });

            const missing = parsed(`${RUN_ID}-missing`, 100, {
                splits: [
                    { accountGuid: testGuid(), amountCents: 100 },
                    { accountGuid: CHECKING_GUID, amountCents: -100 },
                ],
            });
            await expect(service.createBeezTransaction(context, actor(), missing, null))
                .rejects.toMatchObject({ status: 404, code: 'account_not_found' });
        });

        it('refuses a placeholder account', async () => {
            const input = parsed(`${RUN_ID}-placeholder`, 100, {
                splits: [
                    { accountGuid: PLACEHOLDER_GUID, amountCents: 100 },
                    { accountGuid: CHECKING_GUID, amountCents: -100 },
                ],
            });
            await expect(service.createBeezTransaction(context, actor(), input, null))
                .rejects.toMatchObject({ status: 422, code: 'placeholder_account' });
        });

        it('refuses an account denominated in another currency', async () => {
            const input = parsed(`${RUN_ID}-fx`, 100, {
                splits: [
                    { accountGuid: FOREIGN_GUID, amountCents: 100 },
                    { accountGuid: CHECKING_GUID, amountCents: -100 },
                ],
            });
            await expect(service.createBeezTransaction(context, actor(), input, null))
                .rejects.toMatchObject({ status: 422, code: 'currency_mismatch' });
        });

        it('lets exactly one of two concurrent creates for the same id win', async () => {
            const id = `${RUN_ID}-race`;

            // Without synchronization this test proves nothing: two awaited
            // service calls normally interleave so that the second one's
            // preflight link read already sees the first one's committed row,
            // and it returns "already linked" without ever attempting an
            // insert — the unique-index recovery path stays untouched and the
            // assertions below pass anyway.
            //
            // The barrier forces the real race. `assertAccountsUsable` runs on
            // the global client AFTER the preflight link read and BEFORE the
            // insert, so holding both calls there guarantees each has already
            // seen "no link" and each will go on to insert. Exactly one can
            // win uq_external_links_external_id; the loser MUST come back
            // through the P2002 recovery.
            const prismaModule = await import('@/lib/prisma');
            const client = prismaModule.default;
            const original = client.accounts.findMany.bind(client.accounts);

            let arrived = 0;
            let openGate: () => void = () => {};
            const gate = new Promise<void>((resolve) => { openGate = resolve; });

            const spy = vi.spyOn(client.accounts, 'findMany').mockImplementation((async (args: unknown) => {
                const rows = await original(args as Parameters<typeof original>[0]);
                arrived += 1;
                if (arrived >= 2) openGate();
                await gate;
                return rows;
            }) as typeof client.accounts.findMany);

            let left: Awaited<ReturnType<typeof service.createBeezTransaction>>;
            let right: Awaited<ReturnType<typeof service.createBeezTransaction>>;
            try {
                [left, right] = await Promise.all([
                    service.createBeezTransaction(context, actor(), parsed(id, 100), null),
                    service.createBeezTransaction(context, actor(), parsed(id, 100), null),
                ]);
            } finally {
                spy.mockRestore();
            }

            // Both writers really did reach the insert.
            expect(arrived).toBe(2);

            // Both callers get an answer, both name the SAME transaction, and
            // the database — not an application check — is what decided.
            expect(left.result.transactionGuid).toBe(right.result.transactionGuid);

            // One fresh 201, and one 200 that could only have come from the
            // recovery path: the loser had already read "no link" before it
            // tried, so the only way it can be answering from an existing link
            // is by having lost the unique index and re-read the winner's row.
            const statuses = [left.status, right.status].sort();
            expect(statuses).toEqual([200, 201]);
            const loser = left.status === 200 ? left : right;
            expect(loser.result.alreadyLinked).toBe(true);
            expect(loser.result.externalId).toBe(id);

            const links = await getTestPool().query<{ n: string }>(
                `SELECT count(*)::text AS n FROM gnucash_web_external_links
                 WHERE book_guid = $1 AND external_id = $2`,
                [BOOK_GUID, id],
            );
            expect(links.rows[0].n).toBe('1');

            // The loser's transaction row was rolled back with its link insert,
            // so no orphan ledger entry survives the race.
            const orphans = await getTestPool().query<{ n: string }>(
                `SELECT count(*)::text AS n FROM splits
                 WHERE account_guid = $1 AND value_num = 100 AND tx_guid <> $2`,
                [EXPENSE_GUID, left.result.transactionGuid],
            );
            expect(orphans.rows[0].n).toBe('0');
        });

        it('replays a completed DELETE from its key instead of 404-ing on its own success', async () => {
            const id = `${RUN_ID}-del-replay`;
            const key = `${RUN_ID}-del-key`;
            await service.createBeezTransaction(context, actor(), parsed(id, 1100), null);

            const first = await service.deleteBeezTransaction(context, actor(), id, key);
            expect(first).toEqual({ deleted: true });

            // beez retries on timeout. The link is gone — its own first attempt
            // removed it — so a lookup-before-claim ordering would answer 404
            // for a deletion that demonstrably happened.
            const replay = await service.deleteBeezTransaction(context, actor(), id, key);
            expect(replay).toEqual({ deleted: true });
        });

        it('replays a completed POST from its key even when the body has since gone invalid', async () => {
            const id = `${RUN_ID}-post-replay`;
            const key = `${RUN_ID}-post-replay-key`;
            const first = await service.createBeezTransaction(context, actor(), parsed(id, 1300), key);
            expect(first.status).toBe(201);

            // Same key, but a body that would now be refused outright: a
            // placeholder account is a 422 on any fresh request. The claim is
            // taken before any precondition is read, so the stored success is
            // returned rather than a precondition failure for work that already
            // committed.
            const replay = await service.createBeezTransaction(
                context,
                actor(),
                parsed(`${RUN_ID}-post-replay-other`, 1300, {
                    splits: [
                        { accountGuid: PLACEHOLDER_GUID, amountCents: 1300 },
                        { accountGuid: CHECKING_GUID, amountCents: -1300 },
                    ],
                }),
                key,
            );
            expect(replay.status).toBe(200);
            expect(replay.result.transactionGuid).toBe(first.result.transactionGuid);
            expect(replay.result.alreadyLinked).toBe(true);
        });

        it('refuses an unbalanced set whose float sum rounds to zero, and writes nothing', async () => {
            // Each amount is a safe integer, so each passes the per-split check.
            // Summed as JavaScript numbers the four reduce to 0; the exact sum
            // is 1. Accepting them would persist a transaction that is off by a
            // cent while every reader believes it balances.
            const adversarial = [
                9007199254740991,
                9007199254740990,
                -9007199254740991,
                -9007199254740989,
            ];
            expect(adversarial.reduce((sum, cents) => sum + cents, 0)).toBe(0);

            // PostgreSQL agrees with BigInt, not with the float reduction —
            // which is exactly why the check has to be exact before the write.
            const exact = await getTestPool().query<{ total: string }>(
                `SELECT ($1::bigint + $2::bigint + $3::bigint + $4::bigint)::text AS total`,
                adversarial.map(String),
            );
            expect(exact.rows[0].total).toBe('1');

            const id = `${RUN_ID}-float-unbalanced`;
            const result = beez.parseBeezTransactionInput(
                {
                    externalId: id,
                    postDate: '2026-08-25',
                    description: 'Off by one cent',
                    num: '',
                    splits: adversarial.map((amountCents, index) => ({
                        accountGuid: index % 2 === 0 ? EXPENSE_GUID : CHECKING_GUID,
                        amountCents,
                    })),
                },
                { requireExternalId: true },
            );
            expect(result).toMatchObject({ ok: false, error: 'unbalanced' });
            if (!result.ok) expect(result.detail).toContain('got 1');

            // Refused at the door means nothing reached the ledger.
            const links = await getTestPool().query<{ n: string }>(
                `SELECT count(*)::text AS n FROM gnucash_web_external_links
                 WHERE book_guid = $1 AND external_id = $2`,
                [BOOK_GUID, id],
            );
            expect(links.rows[0].n).toBe('0');
        });
    });

    describe('replace', () => {
        const externalId = `${RUN_ID}-replace`;
        let txGuid = '';

        beforeAll(async () => {
            const created = await service.createBeezTransaction(
                context, actor(), parsed(externalId, 2000), null,
            );
            txGuid = created.result.transactionGuid;
        });

        it('replaces description, date, and the whole split set, and bumps enter_date', async () => {
            const before = await getTestPool().query<{ enter_date: Date }>(
                `SELECT enter_date FROM transactions WHERE guid = $1`, [txGuid],
            );

            const result = await service.replaceBeezTransaction(
                context, actor(), externalId,
                parsed(null, 3300, { postDate: '2026-09-01', description: 'Corrected: frames' }),
                null,
            );
            expect(result.transactionGuid).toBe(txGuid);

            const pool = getTestPool();
            const row = await pool.query<{ description: string; post_date: Date; enter_date: Date }>(
                `SELECT description, post_date, enter_date FROM transactions WHERE guid = $1`, [txGuid],
            );
            expect(row.rows[0].description).toBe('Corrected: frames');
            expect(row.rows[0].post_date.toISOString().slice(0, 10)).toBe('2026-09-01');
            // A fresh enter_date is what invalidates any browser tab's
            // optimistic-lock token for this row.
            expect(row.rows[0].enter_date.getTime()).toBeGreaterThan(before.rows[0].enter_date.getTime());

            const splits = await pool.query<{ n: string; total: string }>(
                `SELECT count(*)::text AS n, sum(value_num)::text AS total FROM splits WHERE tx_guid = $1`,
                [txGuid],
            );
            expect(splits.rows[0]).toEqual({ n: '2', total: '0' });

            const amounts = await pool.query<{ value_num: string }>(
                `SELECT value_num::text FROM splits WHERE tx_guid = $1 ORDER BY value_num DESC`, [txGuid],
            );
            expect(amounts.rows.map(r => r.value_num)).toEqual(['3300', '-3300']);
        });

        it('404s for an external id nobody linked', async () => {
            await expect(service.replaceBeezTransaction(
                context, actor(), `${RUN_ID}-nobody`, parsed(null, 100), null,
            )).rejects.toMatchObject({ status: 404, code: 'unknown_external_id' });
        });

        it('refuses to move a reconciled transaction', async () => {
            const id = `${RUN_ID}-reconciled`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 400), null);
            await getTestPool().query(
                `UPDATE splits SET reconcile_state = 'y' WHERE tx_guid = $1 AND account_guid = $2`,
                [created.result.transactionGuid, CHECKING_GUID],
            );

            await expect(service.replaceBeezTransaction(context, actor(), id, parsed(null, 999), null))
                .rejects.toMatchObject({ status: 409, code: 'reconciled' });

            // Nothing was written before the guard fired.
            const amounts = await getTestPool().query<{ n: string }>(
                `SELECT count(*)::text AS n FROM splits WHERE tx_guid = $1 AND value_num = 999`,
                [created.result.transactionGuid],
            );
            expect(amounts.rows[0].n).toBe('0');
        });

        it('refuses to move a FROZEN transaction too, not just a reconciled one', async () => {
            // 'f' is the other state src/lib/services/reconciled-split.service.ts
            // protects, and every browser path already refuses it. A private
            // `state === 'y'` test here would let beez rewrite a split folio
            // itself will not touch.
            const id = `${RUN_ID}-frozen`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 450), null);
            await getTestPool().query(
                `UPDATE splits SET reconcile_state = 'f' WHERE tx_guid = $1 AND account_guid = $2`,
                [created.result.transactionGuid, CHECKING_GUID],
            );

            await expect(service.replaceBeezTransaction(context, actor(), id, parsed(null, 888), null))
                .rejects.toMatchObject({ status: 409, code: 'reconciled' });

            const amounts = await getTestPool().query<{ n: string }>(
                `SELECT count(*)::text AS n FROM splits WHERE tx_guid = $1 AND value_num = 888`,
                [created.result.transactionGuid],
            );
            expect(amounts.rows[0].n).toBe('0');
        });
    });

    describe('delete', () => {
        it('removes the transaction, its splits, its meta, and the link', async () => {
            const id = `${RUN_ID}-delete`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 600), null);
            const txGuid = created.result.transactionGuid;

            const result = await service.deleteBeezTransaction(context, actor(), id, null);
            expect(result).toEqual({ deleted: true });

            const pool = getTestPool();
            for (const [table, column] of [
                ['transactions', 'guid'],
                ['splits', 'tx_guid'],
                ['gnucash_web_transaction_meta', 'transaction_guid'],
            ] as const) {
                const rows = await pool.query<{ n: string }>(
                    `SELECT count(*)::text AS n FROM ${table} WHERE ${column} = $1`, [txGuid],
                );
                expect(rows.rows[0].n, table).toBe('0');
            }
            const link = await pool.query<{ n: string }>(
                `SELECT count(*)::text AS n FROM gnucash_web_external_links
                 WHERE book_guid = $1 AND external_id = $2`,
                [BOOK_GUID, id],
            );
            expect(link.rows[0].n).toBe('0');
        });

        it('404s for an external id nobody linked', async () => {
            await expect(service.deleteBeezTransaction(context, actor(), `${RUN_ID}-nope`, null))
                .rejects.toMatchObject({ status: 404, code: 'unknown_external_id' });
        });

        it('refuses to delete a reconciled transaction', async () => {
            const id = `${RUN_ID}-del-reconciled`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 700), null);
            await getTestPool().query(
                `UPDATE splits SET reconcile_state = 'y' WHERE tx_guid = $1 AND account_guid = $2`,
                [created.result.transactionGuid, CHECKING_GUID],
            );

            await expect(service.deleteBeezTransaction(context, actor(), id, null))
                .rejects.toMatchObject({ status: 409, code: 'reconciled' });

            const rows = await getTestPool().query<{ n: string }>(
                `SELECT count(*)::text AS n FROM transactions WHERE guid = $1`,
                [created.result.transactionGuid],
            );
            expect(rows.rows[0].n).toBe('1');
        });

        it('refuses to delete a FROZEN transaction too, not just a reconciled one', async () => {
            const id = `${RUN_ID}-del-frozen`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 750), null);
            await getTestPool().query(
                `UPDATE splits SET reconcile_state = 'f' WHERE tx_guid = $1 AND account_guid = $2`,
                [created.result.transactionGuid, CHECKING_GUID],
            );

            await expect(service.deleteBeezTransaction(context, actor(), id, null))
                .rejects.toMatchObject({ status: 409, code: 'reconciled' });

            const rows = await getTestPool().query<{ n: string }>(
                `SELECT count(*)::text AS n FROM transactions WHERE guid = $1`,
                [created.result.transactionGuid],
            );
            expect(rows.rows[0].n).toBe('1');
            // The link survives too: a refused delete must not half-apply.
            const link = await getTestPool().query<{ n: string }>(
                `SELECT count(*)::text AS n FROM gnucash_web_external_links
                 WHERE book_guid = $1 AND external_id = $2`,
                [BOOK_GUID, id],
            );
            expect(link.rows[0].n).toBe('1');
        });
    });

    describe('change feed', () => {
        it('pages in (enter_date, guid) order and resumes exactly where it stopped', async () => {
            const first = await service.getBeezChanges(context, { since: null, limit: 2 });
            expect(first.items.filter(item => !item.deleted).length).toBe(2);
            expect(first.hasMore).toBe(true);
            expect(first.nextCursor).toBeTruthy();

            const second = await service.getBeezChanges(context, { since: first.nextCursor, limit: 2 });
            const firstGuids = first.items.filter(i => !i.deleted).map(i => i.transactionGuid);
            const secondGuids = second.items.filter(i => !i.deleted).map(i => i.transactionGuid);
            // No overlap and no gap: paging a feed that duplicates or skips is
            // worse than no feed at all.
            expect(secondGuids.some(guid => firstGuids.includes(guid))).toBe(false);
        });

        it('reports the external id, cents, and reconcile state of each split', async () => {
            const id = `${RUN_ID}-feed`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 4321), null);

            const feed = await service.getBeezChanges(context, { since: null, limit: 500 });
            const item = feed.items.find(entry => entry.transactionGuid === created.result.transactionGuid);
            expect(item).toBeDefined();
            expect(item?.externalId).toBe(id);
            expect(item?.deleted).toBe(false);
            expect(item?.postDate).toBe('2026-08-25');
            expect(item?.unrepresentable).toBeUndefined();
            expect([...(item?.splits ?? [])].sort((a, b) => b.amountCents - a.amountCents)).toEqual([
                { accountGuid: EXPENSE_GUID, amountCents: 4321, memo: 'supplies', reconcileState: 'n' },
                { accountGuid: CHECKING_GUID, amountCents: -4321, memo: '', reconcileState: 'n' },
            ]);
        });

        it('leaves externalId null for a transaction folio owns', async () => {
            const txGuid = testGuid();
            const pool = getTestPool();
            await pool.query(
                `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
                 VALUES ($1, $2, '', NOW(), NOW(), 'Entered in folio')`,
                [txGuid, USD_GUID],
            );
            await pool.query(
                `INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state,
                                     value_num, value_denom, quantity_num, quantity_denom)
                 VALUES ($1, $3, $4, '', '', 'n', 100, 100, 100, 100),
                        ($2, $3, $5, '', '', 'n', -100, 100, -100, 100)`,
                [testGuid(), testGuid(), txGuid, EXPENSE_GUID, CHECKING_GUID],
            );

            const feed = await service.getBeezChanges(context, { since: null, limit: 500 });
            const item = feed.items.find(entry => entry.transactionGuid === txGuid);
            expect(item?.externalId).toBeNull();
            expect(item?.description).toBe('Entered in folio');
        });

        it('marks a transaction unrepresentable rather than rounding a thirds fraction', async () => {
            const txGuid = testGuid();
            const pool = getTestPool();
            await pool.query(
                `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
                 VALUES ($1, $2, '', NOW(), NOW(), 'Split three ways')`,
                [txGuid, USD_GUID],
            );
            // 1/3 has no exact cents value. Rounding it would invent money, so
            // the whole item is reported as a conflict with no splits.
            await pool.query(
                `INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state,
                                     value_num, value_denom, quantity_num, quantity_denom)
                 VALUES ($1, $3, $4, '', '', 'n', 1, 3, 1, 3),
                        ($2, $3, $5, '', '', 'n', -1, 3, -1, 3)`,
                [testGuid(), testGuid(), txGuid, EXPENSE_GUID, CHECKING_GUID],
            );

            const feed = await service.getBeezChanges(context, { since: null, limit: 500 });
            const item = feed.items.find(entry => entry.transactionGuid === txGuid);
            expect(item?.unrepresentable).toBe(true);
            expect(item?.splits).toEqual([]);
        });

        it('delivers a NULL-enter_date transaction in the always-emitted set rather than losing it', async () => {
            const txGuid = await insertNullEnterDateTransaction('No enter date');

            const feed = await service.getBeezChanges(context, { since: null, limit: 500 });
            const guids = feed.items.filter(i => !i.deleted).map(i => i.transactionGuid);
            expect(guids).toContain(txGuid);
            // It carries no enterDate, which is how a client tells the
            // always-emitted set apart from the ordered page.
            expect(feed.items.find(i => i.transactionGuid === txGuid)?.enterDate).toBeNull();
            // The set is appended after the ordered page, never inside it.
            expect(guids[guids.length - 1]).toBe(txGuid);
        });

        it('keeps later normal rows reachable after a NULL-enter_date row is consumed', async () => {
            // The defect this pins down: the old cursor could encode "inside the
            // NULL tail". A client that consumed a NULL row stored that cursor,
            // and every transaction written afterwards — with a perfectly normal
            // enter_date — sorted BEFORE it and was skipped forever.
            const nullGuid = await insertNullEnterDateTransaction('Null row, then more work');

            const drained = await service.getBeezChanges(context, { since: null, limit: 500 });
            expect(drained.items.map(i => i.transactionGuid)).toContain(nullGuid);
            expect(drained.hasMore).toBe(false);

            const id = `${RUN_ID}-after-null`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 1500), null);

            const next = await service.getBeezChanges(context, { since: drained.nextCursor, limit: 500 });
            const guids = next.items.filter(i => !i.deleted).map(i => i.transactionGuid);
            expect(guids).toContain(created.result.transactionGuid);
            // And the NULL row is still delivered, because it has no position to
            // fall behind — bounded repetition, never loss.
            expect(guids).toContain(nullGuid);
        });

        it('stays reachable behind a watermark set by the database clock', async () => {
            // The app host and the database host are different machines with
            // different clocks, and this repository writes `enter_date` from
            // BOTH: most paths use a JavaScript `new Date()`, while
            // lot-assignment.ts, reconcile.ts and statement-reconcile-data.ts
            // use SQL `NOW()`. If a beez write stamped the app clock while the
            // watermark had been set by a DB-stamped row, then every time the
            // database clock ran ahead the new transaction would sort BEHIND
            // the cursor and never be delivered — silent, permanent loss.
            //
            // The row below is stamped by the database, exactly like those
            // three paths. Whatever the skew between the two hosts, a beez
            // transaction written afterwards must still come back.
            const pool = getTestPool();
            const dbStampedGuid = testGuid();
            await pool.query(
                `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
                 VALUES ($1, $2, '', NOW(), clock_timestamp(), 'Stamped by the database clock')`,
                [dbStampedGuid, USD_GUID],
            );
            await insertBalancedSplits(dbStampedGuid, 700);

            const drained = await service.getBeezChanges(context, { since: null, limit: 500 });
            expect(drained.items.map(i => i.transactionGuid)).toContain(dbStampedGuid);
            expect(drained.hasMore).toBe(false);

            const id = `${RUN_ID}-clock-skew`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 1700), null);

            // Both the response and the feed must speak the same microsecond
            // dialect, or a client diffing them sees a change that never
            // happened.
            expect(created.result.enterDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

            const next = await service.getBeezChanges(context, { since: drained.nextCursor, limit: 500 });
            const item = next.items.find(i => i.transactionGuid === created.result.transactionGuid);
            expect(item).toBeDefined();
            expect(item?.enterDate).toBe(created.result.enterDate);
        });

        it('does not re-emit a row stored at microsecond precision', async () => {
            // enter_date is TIMESTAMP(6). A cursor that round-tripped through a
            // millisecond JS Date would name …56.123, the row would still
            // compare greater, and it would come back on every poll forever.
            const txGuid = testGuid();
            const pool = getTestPool();
            // Five minutes ahead — comfortably inside the skew horizon, so the
            // row is ORDERED rather than quarantined (src/lib/enter-date.ts),
            // which is what puts the cursor exactly on it. A fixed far-future
            // literal would be quarantined and re-emitted by design, proving
            // nothing about the cursor.
            const inserted = await pool.query<{ enter_date: string }>(
                `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
                 VALUES ($1, $2, '', NOW(),
                         date_trunc('second', (clock_timestamp() AT TIME ZONE 'UTC'))
                            + interval '5 minutes' + interval '123456 microseconds',
                         'Microsecond boundary')
                 RETURNING to_char(enter_date, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS enter_date`,
                [txGuid, USD_GUID],
            );
            const stamp = inserted.rows[0].enter_date;
            expect(stamp).toMatch(/\.123456$/);
            await insertBalancedSplits(txGuid, 100);

            const feed = await service.getBeezChanges(context, { since: null, limit: 500 });
            const item = feed.items.find(entry => entry.transactionGuid === txGuid);
            expect(item).toBeDefined();
            // The payload carries the microseconds too, not a truncated Date.
            expect(item?.enterDate).toBe(`${stamp}Z`);
            // Once per sweep, never twice on one page.
            expect(feed.items.filter(entry => entry.transactionGuid === txGuid)).toHaveLength(1);

            // The cursor kept every microsecond too — a Date round trip here
            // would have written `…56.123`, which still compares GREATER than
            // the row and re-emits it on every poll for the life of the client.
            const issued = beez.decodeChangesCursor(feed.nextCursor as string);
            expect(issued?.enterDate).toBe(stamp);

            // Continuing a sweep from a position sitting exactly on the row
            // excludes it. This is the comparison the truncation broke: at
            // microsecond precision the tuple is equal, so `>` is false.
            const midSweep = beez.encodeChangesCursor({
                ...(issued as import('@/lib/integrations/beez').ChangesCursor),
                sweepEnterDate: stamp,
                sweepGuid: txGuid,
            });
            const after = await service.getBeezChanges(context, { since: midSweep, limit: 500 });
            expect(after.items.map(i => i.transactionGuid)).not.toContain(txGuid);

            // Its enter_date is deliberately in the future so it sorts last and
            // the cursor lands exactly on it. Drop it again so it does not sit
            // ahead of every row a later test writes.
            await dropTransaction(txGuid);
        });

        it('pages a sweep without skipping or duplicating inside it', async () => {
            const drained = await service.getBeezChanges(context, { since: null, limit: 500 });
            expect(drained.hasMore).toBe(false);

            const expected: string[] = [];
            for (let index = 0; index < 5; index += 1) {
                const created = await service.createBeezTransaction(
                    context, actor(), parsed(`${RUN_ID}-page-${index}`, 100 + index), null,
                );
                expected.push(created.result.transactionGuid);
            }

            // A sweep re-reads the whole overlap band, so it covers this
            // suite's earlier rows as well as the five above — that is the
            // design, not a leak. What must hold WITHIN one sweep is the old
            // property: strictly forward, every row exactly once.
            const { ordered, polls } = await sweepFrom(drained.nextCursor, 2);
            expect(polls).toBeGreaterThan(1);
            expect(new Set(ordered).size, 'a sweep must not repeat a row').toBe(ordered.length);
            for (const guid of expected) expect(ordered).toContain(guid);

            // Each page except the last carried a full `limit` of ordered rows,
            // so nothing was dropped at a page boundary either.
            expect(ordered.length).toBeGreaterThanOrEqual(5);
        });

        it('makes progress when the overlap band is larger than one page', async () => {
            // The failure mode a naive overlap has: re-derive the sweep floor
            // from the high watermark on EVERY poll and, once the band holds
            // more rows than `limit`, each poll re-reads the same first page,
            // re-issues the same watermark, and the tail is never reached. A
            // client would loop forever having consumed nothing new.
            //
            // `limit: 1` makes the band larger than a page by construction —
            // this suite has written far more than one row in the last two
            // hours — so a stalled sweep fails here as a clean assertion.
            const { ordered, polls } = await sweepFrom(null, 1);
            expect(polls).toBeGreaterThan(3);
            expect(new Set(ordered).size).toBe(ordered.length);

            // And the sweep genuinely terminated rather than hitting the guard.
            const last = await service.getBeezChanges(context, { since: null, limit: 500 });
            for (const guid of last.items.filter(i => !i.deleted && !i.quarantined).map(i => i.transactionGuid)) {
                expect(ordered).toContain(guid);
            }
        });

        it('emits a tombstone for a link whose transaction was deleted in folio, until DELETE clears it', async () => {
            const id = `${RUN_ID}-tombstone`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 800), null);
            const pool = getTestPool();
            // Simulate a folio-side deletion that beez has not seen yet: the
            // transaction goes, the link stays behind as the tombstone.
            await pool.query(`DELETE FROM splits WHERE tx_guid = $1`, [created.result.transactionGuid]);
            await pool.query(`DELETE FROM gnucash_web_transaction_meta WHERE transaction_guid = $1`,
                [created.result.transactionGuid]);
            await pool.query(`DELETE FROM transactions WHERE guid = $1`, [created.result.transactionGuid]);

            const feed = await service.getBeezChanges(context, { since: null, limit: 5 });
            expect(feed.items).toContainEqual({ externalId: id, deleted: true });

            // A POST for the unacknowledged id must not resurrect it.
            await expect(service.createBeezTransaction(context, actor(), parsed(id, 800), null))
                .rejects.toMatchObject({ status: 409, code: 'link_orphaned' });

            // DELETE is the acknowledgement, and it clears the tombstone.
            const ack = await service.deleteBeezTransaction(context, actor(), id, null);
            expect(ack).toEqual({ deleted: true, orphanLinkRemoved: true });

            const after = await service.getBeezChanges(context, { since: null, limit: 5 });
            expect(after.items.some(item => item.deleted && item.externalId === id)).toBe(false);
        });

        it('rejects a cursor it did not issue instead of replaying the whole ledger', async () => {
            await expect(service.getBeezChanges(context, { since: 'garbage!!', limit: 10 }))
                .rejects.toMatchObject({ status: 422, code: 'validation' });
        });

        it('drains a NULL-enter_date set larger than one page, over repeated polls', async () => {
            // The defect: the NULL set was emitted unpaged and bounded by
            // `limit`, so with more NULL rows than fit on a page the SAME
            // guid-ordered prefix came back on every poll and the tail was
            // unreachable — while `hasMore`, computed from the ordered stream
            // alone, cheerfully said there was nothing left to fetch.
            const PAGE = 2;
            const mine = [
                await insertNullEnterDateTransaction('drain 1'),
                await insertNullEnterDateTransaction('drain 2'),
                await insertNullEnterDateTransaction('drain 3'),
            ];

            // Every NULL row in the book, not just this test's: the set is
            // book-wide and earlier tests left theirs behind on purpose.
            const allNullGuids = new Set(
                (await getTestPool().query<{ guid: string }>(
                    `SELECT t.guid FROM transactions t
                     WHERE t.enter_date IS NULL AND EXISTS (
                         SELECT 1 FROM splits s
                         WHERE s.tx_guid = t.guid AND s.account_guid = ANY($1::text[])
                     )`,
                    [[CHECKING_GUID, EXPENSE_GUID]],
                )).rows.map(row => row.guid),
            );
            expect(allNullGuids.size).toBeGreaterThan(PAGE);

            // Poll until the NULL set drains. Bounded so a regression fails as a
            // clean assertion rather than hanging the suite.
            const seen = new Set<string>();
            let cursor: string | null = null;
            let polls = 0;
            for (; polls < 20; polls += 1) {
                const response = await service.getBeezChanges(context, { since: cursor, limit: PAGE });
                // NULL rows are the subset of the quarantine set with no
                // enter_date at all; rows stamped past the horizon are the
                // other subset and carry one (see the horizon tests below).
                const nullItems = response.items.filter(
                    item => !item.deleted && item.quarantined && item.enterDate === null,
                );
                nullItems.forEach(item => seen.add(item.transactionGuid as string));
                cursor = response.nextCursor;
                if (nullItems.length < PAGE) break;
                // While rows remain, hasMore must say so even once the ordered
                // stream is exhausted — that is the half of the bug that made
                // the loss silent.
                expect(response.hasMore, `poll ${polls}`).toBe(true);
            }
            expect(polls).toBeLessThan(20);
            for (const guid of allNullGuids) expect([...seen]).toContain(guid);

            // A NULL row that appears AFTER the watermark advanced past its guid
            // still has to be delivered. It has no timestamp, so there is no
            // "after" to scan from; the watermark resets on drain, and the next
            // full pass picks it up.
            const late = await insertNullEnterDateTransaction('drain 4, arrived late');
            const seenAfter = new Set<string>();
            for (let poll = 0; poll < 20; poll += 1) {
                const response = await service.getBeezChanges(context, { since: cursor, limit: PAGE });
                response.items
                    .filter(item => !item.deleted && item.quarantined && item.enterDate === null)
                    .forEach(item => seenAfter.add(item.transactionGuid as string));
                cursor = response.nextCursor;
                if (seenAfter.has(late)) break;
            }
            expect([...seenAfter]).toContain(late);

            for (const guid of [...mine, late]) await dropTransaction(guid);
        });

        it('stays reachable when an app-clock writer stamped a row into the future', async () => {
            // Inverse skew, the case a plain clock_timestamp() stamp loses. Most
            // of this repository writes enter_date from the APP host's clock. If
            // that host runs fast, its row lands in the future, a poll advances
            // the feed's watermark onto it, and every database-stamped write for
            // the length of the skew sorts BEHIND the cursor — gone, silently
            // and permanently.
            const pool = getTestPool();
            const futureGuid = testGuid();
            await pool.query(
                `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
                 VALUES ($1, $2, '', NOW(), (clock_timestamp() AT TIME ZONE 'UTC') + interval '5 minutes',
                         'Stamped by a fast app clock')`,
                [futureGuid, USD_GUID],
            );
            await insertBalancedSplits(futureGuid, 900);

            const drained = await service.getBeezChanges(context, { since: null, limit: 500 });
            expect(drained.items.map(i => i.transactionGuid)).toContain(futureGuid);
            expect(drained.hasMore).toBe(false);

            const id = `${RUN_ID}-inverse-skew`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 1900), null);

            const next = await service.getBeezChanges(context, { since: drained.nextCursor, limit: 500 });
            expect(next.items.map(i => i.transactionGuid)).toContain(created.result.transactionGuid);

            // Both rows are ahead of the wall clock; leaving them would drag
            // every later stamp in this file forward with them.
            await service.deleteBeezTransaction(context, actor(), id, null);
            await dropTransaction(futureGuid);
        });

        it('bumps enter_date by a whole millisecond, so a stale browser token cannot still match', async () => {
            // The browser's optimistic-lock token is a JS Date and compares at
            // MILLISECOND precision (src/app/api/transactions/[guid]/route.ts).
            // A microsecond-only bump — …123000 to …123456 — leaves a tab's
            // stale token matching, and that tab then overwrites the beez write
            // without ever seeing a conflict.
            const pool = getTestPool();
            const id = `${RUN_ID}-ms-bump`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 2100), null);

            // Pin the row's enter_date to an exact millisecond boundary in the
            // near future, so the wall clock cannot supply the separation by
            // accident: whatever this asserts, it asserts about the bump.
            const pinned = await pool.query<{ enter_date: string }>(
                `UPDATE transactions
                 SET enter_date = date_trunc('millisecond',
                        (clock_timestamp() AT TIME ZONE 'UTC') + interval '30 seconds')
                 WHERE guid = $1
                 RETURNING to_char(enter_date, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS enter_date`,
                [created.result.transactionGuid],
            );
            const before = pinned.rows[0].enter_date;
            expect(before).toMatch(/\.\d{3}000$/);

            const replaced = await service.replaceBeezTransaction(
                context, actor(), id, parsed(null, 2200), null,
            );
            const after = replaced.enterDate.replace(/Z$/, '');

            // The microsecond strings differ...
            expect(after).not.toBe(before);
            // ...and so do the MILLISECONDS, which is the comparison the browser
            // actually makes. This is the stale token going stale.
            const asBrowserToken = (stamp: string) => new Date(`${stamp}Z`).getTime();
            expect(asBrowserToken(after)).toBeGreaterThan(asBrowserToken(before));

            await service.deleteBeezTransaction(context, actor(), id, null);
        });

        it('answers 422 for a cursor whose fields are not a real instant, not 500', async () => {
            // Shape-only validation let this reach the feed query's
            // `::timestamp` cast, where PostgreSQL raised "date/time field value
            // out of range" and the client saw a server fault for its own bad
            // input.
            const impossible = Buffer.from(
                JSON.stringify({ e: '2026-99-99T99:99:99.999999', g: 'a'.repeat(32) }),
                'utf8',
            ).toString('base64url');

            await expect(service.getBeezChanges(context, { since: impossible, limit: 10 }))
                .rejects.toMatchObject({ status: 422, code: 'validation' });

            // And the route translates that into the documented 422 body rather
            // than the shell's catch-all 500.
            const { beezErrorResponse } = await import('@/lib/integrations/beez-route');
            const caught = await service
                .getBeezChanges(context, { since: impossible, limit: 10 })
                .catch((error: unknown) => error);
            const response = beezErrorResponse(caught);
            expect(response.status).toBe(422);
            expect(await response.json()).toEqual({
                error: 'validation',
                detail: 'since: not a cursor issued by this endpoint',
            });
        });

        it('never rewinds its high watermark, however far a sweep restarts below it', async () => {
            // The watermark is what the NEXT sweep's floor is measured from. If
            // re-emitted rows — which all sort BELOW it — were allowed to move
            // it, the floor would walk backwards one poll at a time until the
            // feed was replaying the whole ledger on every pass.
            const all = await service.getBeezChanges(context, { since: null, limit: 500 });
            expect(all.hasMore).toBe(false);
            const high = beez.decodeChangesCursor(all.nextCursor as string);
            expect(high?.enterDate).toBeTruthy();
            // A drained sweep clears its position; that clear is what makes the
            // next pass start low.
            expect(high?.sweepEnterDate).toBeNull();

            const again = await service.getBeezChanges(context, { since: all.nextCursor, limit: 500 });
            // Nothing was written in between, so the overlap re-emits and only
            // re-emits: no row above the watermark appears.
            const repeated = again.items.filter(item => !item.deleted && !item.quarantined);
            expect(repeated.length).toBeGreaterThan(0);
            const nextHigh = beez.decodeChangesCursor(again.nextCursor as string);
            expect(nextHigh?.enterDate).toBe(high?.enterDate);
            expect(nextHigh?.guid).toBe(high?.guid);
            expect(again.hasMore).toBe(false);
        });

        it('re-emits a row byte for byte, so transactionGuid + enterDate dedups it', async () => {
            // The wire contract sells duplicates as the price of no loss. That
            // is only payable if a repeat is RECOGNISABLE: an enterDate that
            // drifted between polls would look like an edit and the client
            // would apply the same row twice.
            const id = `${RUN_ID}-dedup`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 5100), null);

            const first = await service.getBeezChanges(context, { since: null, limit: 500 });
            expect(first.hasMore).toBe(false);
            const once = first.items.find(i => i.transactionGuid === created.result.transactionGuid);
            expect(once?.enterDate).toBe(created.result.enterDate);

            const second = await service.getBeezChanges(context, { since: first.nextCursor, limit: 500 });
            const twice = second.items.find(i => i.transactionGuid === created.result.transactionGuid);
            expect(twice, 'the overlap must re-emit it').toBeDefined();
            expect(twice?.enterDate).toBe(once?.enterDate);
            expect(twice).toEqual(once);

            await service.deleteBeezTransaction(context, actor(), id, null);
            await service.getBeezChanges(context, { since: null, limit: 500 });
        });

        it('delivers a bare-NOW() write made behind an in-horizon future cursor', async () => {
            // THE FINDING THIS CLOSES. Most writers in this repository stamp a
            // bare NOW() / new Date(): reconcile.ts, statement-reconcile-data.ts,
            // lot-assignment.ts, the SimpleFin sync, the invoice engine, the
            // Stripe and inbound webhooks, every importer. A cursor may sit up
            // to the skew horizon (one hour) AHEAD of the clock, so such a write
            // lands BELOW it and a strictly-forward watermark drops it forever.
            //
            // Fifty minutes ahead is inside the horizon, so the row is ORDERED
            // and the cursor really does advance onto it — which is precisely
            // the state that used to be fatal.
            const pool = getTestPool();
            const futureGuid = testGuid();
            await pool.query(
                `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
                 VALUES ($1, $2, '', NOW(),
                         (clock_timestamp() AT TIME ZONE 'UTC') + interval '50 minutes',
                         'In-horizon future row')`,
                [futureGuid, USD_GUID],
            );
            await insertBalancedSplits(futureGuid, 1100);

            const issued = await service.getBeezChanges(context, { since: null, limit: 500 });
            expect(issued.hasMore).toBe(false);
            const watermark = beez.decodeChangesCursor(issued.nextCursor as string);
            // The cursor is genuinely on the future row; otherwise this proves
            // nothing about writing behind it.
            expect(watermark?.guid).toBe(futureGuid);
            expect(issued.items.find(i => i.transactionGuid === futureGuid)?.quarantined)
                .toBeUndefined();

            // A bare-NOW() writer, exactly as reconcile.ts and friends spell it.
            const bareGuid = testGuid();
            await pool.query(
                `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
                 VALUES ($1, $2, '', NOW(), NOW(), 'Written by a bare NOW() path')`,
                [bareGuid, USD_GUID],
            );
            await insertBalancedSplits(bareGuid, 1200);

            // Fifty minutes below the watermark, and delivered anyway — that is
            // the overlap doing the job the writers were not asked to do.
            const next = await service.getBeezChanges(context, { since: issued.nextCursor, limit: 500 });
            expect(next.items.map(i => i.transactionGuid)).toContain(bareGuid);

            await dropTransaction(futureGuid);
            await dropTransaction(bareGuid);
        });
    });

    /**
     * The writer half of the cursor contract, exercised through the shared
     * stamper every feed-visible route now uses (src/lib/enter-date.ts).
     *
     * The invariant under test: EVERY CURSOR THE FEED CAN ISSUE IS <= EVERY
     * SUBSEQUENT WRITER'S FLOOR. There are two independent ways to break it:
     *
     *   - a writer that reads the wall clock and nothing else stamps below a
     *     cursor issued from a row a fast host put in the future;
     *   - a feed that orders a row no writer's watermark can reach — a
     *     year-3000 row — issues a cursor no later write can climb above.
     */
    describe('enter_date monotonicity', () => {
        /** A transaction with an enter_date this test dictates, plus splits. */
        async function insertAt(expression: string, description: string): Promise<string> {
            const txGuid = testGuid();
            await getTestPool().query(
                `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
                 VALUES ($1, $2, '', NOW(), ${expression}, $3)`,
                [txGuid, USD_GUID, description],
            );
            await insertBalancedSplits(txGuid, 100);
            return txGuid;
        }

        /** What the browser's optimistic-lock token compares: milliseconds. */
        const asBrowserToken = (stamp: string) => new Date(`${stamp.replace(/Z$/, '')}Z`).getTime();

        it('emits a later edit even after a cursor was issued on a future-clock row', async () => {
            // The defect, exactly: `PUT /api/transactions/[guid]` used to stamp
            // a bare clock_timestamp(). An app host running fast writes a row
            // five minutes ahead; a poll advances the cursor onto it; the next
            // edit stamps at the wall clock, lands BELOW that cursor, and is
            // never delivered. The edit is not late — it is gone.
            const id = `${RUN_ID}-put-after-future`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 3100), null);
            const futureGuid = await insertAt(
                `(clock_timestamp() AT TIME ZONE 'UTC') + interval '5 minutes'`,
                'Stamped by a fast app clock',
            );

            const drained = await service.getBeezChanges(context, { since: null, limit: 500 });
            expect(drained.hasMore).toBe(false);
            // The cursor really is sitting on the future row — otherwise this
            // test proves nothing about writing behind it.
            expect(drained.items.map(item => item.transactionGuid)).toContain(futureGuid);
            const watermark = beez.decodeChangesCursor(drained.nextCursor as string);
            expect(watermark?.guid).toBe(futureGuid);

            // The statement the PUT route issues, on a row stamped minutes ago.
            const stamped = await enterDate.stampEnterDate(db, created.result.transactionGuid);
            expect(asBrowserToken(stamped))
                .toBeGreaterThan(asBrowserToken(watermark?.enterDate as string));

            const next = await service.getBeezChanges(context, { since: drained.nextCursor, limit: 500 });
            const item = next.items.find(entry => entry.transactionGuid === created.result.transactionGuid);
            expect(item).toBeDefined();
            expect(item?.enterDate).toBe(`${stamped}Z`);

            await service.deleteBeezTransaction(context, actor(), id, null);
            await dropTransaction(futureGuid);
        });

        it('leaves a stale millisecond token behind, even from an exact millisecond boundary', async () => {
            // The other half of the same stamp. `enterDateMatches` in
            // src/app/api/transactions/[guid]/route.ts compares JS Dates, so it
            // sees MILLISECONDS. A stamp that stays inside the millisecond it
            // replaced leaves a stale tab's token matching, and that tab
            // overwrites this write with a 200 instead of a 409.
            const id = `${RUN_ID}-put-ms-bump`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 3200), null);
            const txGuid = created.result.transactionGuid;

            // Pinned to an exact millisecond boundary 30 seconds ahead, so the
            // wall clock cannot supply the separation by accident: what this
            // asserts, it asserts about the bump.
            const pinned = await getTestPool().query<{ enter_date: string }>(
                `UPDATE transactions
                 SET enter_date = date_trunc('millisecond',
                        (clock_timestamp() AT TIME ZONE 'UTC') + interval '30 seconds')
                 WHERE guid = $1
                 RETURNING to_char(enter_date, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS enter_date`,
                [txGuid],
            );
            const before = pinned.rows[0].enter_date;
            expect(before).toMatch(/\.\d{3}000$/);

            const after = await enterDate.stampEnterDate(db, txGuid);

            // A full millisecond clear, which is what makes the stale token stop
            // matching — a microsecond-only bump would pass the first of these
            // assertions and fail the second.
            expect(after).not.toBe(before);
            expect(asBrowserToken(after)).toBeGreaterThan(asBrowserToken(before));

            await service.deleteBeezTransaction(context, actor(), id, null);
        });

        it('quarantines a row past the horizon instead of ordering a cursor no writer can reach', async () => {
            // A row dated the year 3000 is not skew, it is corruption. Ordering
            // it would issue a cursor a whole millennium above every writer's
            // floor, and every write until then would sort behind it. So it is
            // excluded from the ORDER — and delivered, on every poll, by the
            // always-emitted quarantine set instead. Not sequenced, not lost.
            const farGuid = await insertAt(`TIMESTAMP '3000-01-01 00:00:00'`, 'Year 3000');

            const drained = await service.getBeezChanges(context, { since: null, limit: 500 });
            const quarantined = drained.items.find(item => item.transactionGuid === farGuid);
            expect(quarantined?.quarantined).toBe(true);
            // It keeps its real enter_date in the payload — the client is told
            // the truth about the row, it just gets no position from it.
            expect(quarantined?.enterDate).toBe('3000-01-01T00:00:00.000000Z');
            expect(quarantined?.splits).toHaveLength(2);

            // The cursor did NOT land on it.
            const watermark = beez.decodeChangesCursor(drained.nextCursor as string);
            expect(watermark?.guid).not.toBe(farGuid);
            expect(watermark?.enterDate ?? '').not.toContain('3000-');

            // Which is the whole point: an ordinary write afterwards is still
            // delivered rather than buried a thousand years behind the cursor.
            const id = `${RUN_ID}-after-far-future`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 3300), null);
            const next = await service.getBeezChanges(context, { since: drained.nextCursor, limit: 500 });
            expect(next.items.map(item => item.transactionGuid))
                .toContain(created.result.transactionGuid);
            // And the quarantined row is still being delivered, because it has
            // no position to fall behind.
            expect(next.items.map(item => item.transactionGuid)).toContain(farGuid);

            await service.deleteBeezTransaction(context, actor(), id, null);
            await dropTransaction(farGuid);
        });

        it('pages a quarantine set larger than one page, over repeated polls', async () => {
            // Same budget and guid watermark the NULL half of the set uses: a
            // set that is re-sent whole on every poll and truncated at `limit`
            // would strand its tail forever.
            const PAGE = 1;
            const far = [
                await insertAt(`TIMESTAMP '3000-02-01 00:00:00'`, 'far 1'),
                await insertAt(`TIMESTAMP '3000-02-02 00:00:00'`, 'far 2'),
                await insertAt(`TIMESTAMP '3000-02-03 00:00:00'`, 'far 3'),
            ];

            const seen = new Set<string>();
            let cursor: string | null = null;
            for (let poll = 0; poll < 40 && far.some(guid => !seen.has(guid)); poll += 1) {
                const response = await service.getBeezChanges(context, { since: cursor, limit: PAGE });
                response.items
                    .filter(item => item.quarantined)
                    .forEach(item => seen.add(item.transactionGuid as string));
                cursor = response.nextCursor;
            }
            for (const guid of far) expect([...seen]).toContain(guid);

            for (const guid of far) await dropTransaction(guid);
        });

        it('strands neither row when two are written back to back', async () => {
            // Sequential stamps must be strictly increasing, not merely
            // non-decreasing: two writes inside one clock tick that landed on
            // the same value could leave the second at or below the cursor the
            // first one issued.
            const idA = `${RUN_ID}-rapid-a`;
            const idB = `${RUN_ID}-rapid-b`;
            const a = await service.createBeezTransaction(context, actor(), parsed(idA, 3400), null);
            const b = await service.createBeezTransaction(context, actor(), parsed(idB, 3500), null);

            const drained = await service.getBeezChanges(context, { since: null, limit: 500 });
            expect(drained.hasMore).toBe(false);

            // Back to back, nothing between them but the statements themselves
            // — the tightest sequence a caller can produce.
            const stampA = await enterDate.stampEnterDate(db, a.result.transactionGuid);
            const stampB = await enterDate.stampEnterDate(db, b.result.transactionGuid);
            expect(stampB > stampA).toBe(true);

            const next = await service.getBeezChanges(context, { since: drained.nextCursor, limit: 500 });
            const guids = next.items.map(item => item.transactionGuid);
            expect(guids).toContain(a.result.transactionGuid);
            expect(guids).toContain(b.result.transactionGuid);

            // And a client that consumed only the first page of that pair still
            // reaches the second: the cursor from a one-row page is below B.
            const firstOnly = await service.getBeezChanges(context, { since: drained.nextCursor, limit: 1 });
            const rest = await service.getBeezChanges(context, { since: firstOnly.nextCursor, limit: 500 });
            const covered = new Set([
                ...firstOnly.items.map(item => item.transactionGuid),
                ...rest.items.map(item => item.transactionGuid),
            ]);
            expect(covered.has(a.result.transactionGuid)).toBe(true);
            expect(covered.has(b.result.transactionGuid)).toBe(true);

            await service.deleteBeezTransaction(context, actor(), idA, null);
            await service.deleteBeezTransaction(context, actor(), idB, null);
        });

        it('gives an undo restoration a fresh stamp instead of its historical one', async () => {
            // The one class of writer the overlap cannot cover: a restore
            // replays a snapshot, and a snapshot's enter_date is as old as the
            // row was. No bounded window catches an arbitrarily old timestamp,
            // so the restore stamps fresh and leaves the historical value where
            // the evidence belongs — in the audit record.
            const audit = await import('@/lib/services/audit.service');
            const pool = getTestPool();

            const id = `${RUN_ID}-undo-restore`;
            const created = await service.createBeezTransaction(context, actor(), parsed(id, 4100), null);
            const txGuid = created.result.transactionGuid;

            // The snapshot a DELETE entry would have captured, aged to 2020 —
            // five years below any overlap band there could ever be.
            const live = await audit.snapshotTransactionByGuid(txGuid);
            expect(live).not.toBeNull();
            const snapshot = { ...(live as NonNullable<typeof live>), enter_date: '2020-01-01T00:00:00.000Z' };

            // Delete it the way a folio-side delete would, link and all, so the
            // restore is a genuine re-create rather than a replace.
            await pool.query(`DELETE FROM gnucash_web_external_links
                              WHERE book_guid = $1 AND external_id = $2`, [BOOK_GUID, id]);
            await pool.query(`DELETE FROM gnucash_web_transaction_meta WHERE transaction_guid = $1`, [txGuid]);
            await pool.query(`DELETE FROM splits WHERE tx_guid = $1`, [txGuid]);
            await pool.query(`DELETE FROM transactions WHERE guid = $1`, [txGuid]);

            const entry = await pool.query<{ id: number }>(
                `INSERT INTO gnucash_web_audit (book_guid, action, entity_type, entity_guid, old_values)
                 VALUES ($1, 'DELETE', 'TRANSACTION', $2, $3::jsonb) RETURNING id`,
                [BOOK_GUID, txGuid, JSON.stringify(snapshot)],
            );

            // A cursor issued BEFORE the restore — the state that makes an
            // old-timestamp write invisible.
            const issued = await service.getBeezChanges(context, { since: null, limit: 500 });
            expect(issued.hasMore).toBe(false);
            expect(issued.items.map(i => i.transactionGuid)).not.toContain(txGuid);

            const undone = await audit.undoAuditEntry(entry.rows[0].id, BOOK_GUID);
            expect(undone.ok, undone.message).toBe(true);

            const restored = await pool.query<{ enter_date: string }>(
                `SELECT to_char(enter_date, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS enter_date
                 FROM transactions WHERE guid = $1`,
                [txGuid],
            );
            expect(restored.rows).toHaveLength(1);
            // Not 2020, and not merely "not null": above the watermark the feed
            // had already handed out.
            expect(restored.rows[0].enter_date.startsWith('2020-')).toBe(false);
            const watermark = beez.decodeChangesCursor(issued.nextCursor as string);
            expect(restored.rows[0].enter_date > (watermark?.enterDate ?? '')).toBe(true);

            // And so it is delivered, which is the whole point.
            const next = await service.getBeezChanges(context, { since: issued.nextCursor, limit: 500 });
            expect(next.items.map(i => i.transactionGuid)).toContain(txGuid);

            await dropTransaction(txGuid);
        });

        it('stamps a whole bulk set above the watermark in one statement', async () => {
            // The bulk paths (PATCH /api/transactions/bulk, the split reconcile
            // and move routes) stamp many rows at once. One statement, one
            // value, and that value still above everything the feed could have
            // issued — including a row a fast host put in the future.
            const idA = `${RUN_ID}-bulk-a`;
            const idB = `${RUN_ID}-bulk-b`;
            const a = await service.createBeezTransaction(context, actor(), parsed(idA, 3600), null);
            const b = await service.createBeezTransaction(context, actor(), parsed(idB, 3700), null);
            const futureGuid = await insertAt(
                `(clock_timestamp() AT TIME ZONE 'UTC') + interval '5 minutes'`,
                'Fast app clock, bulk case',
            );

            const drained = await service.getBeezChanges(context, { since: null, limit: 500 });
            expect(drained.hasMore).toBe(false);
            const watermark = beez.decodeChangesCursor(drained.nextCursor as string);
            expect(watermark?.guid).toBe(futureGuid);

            const count = await enterDate.stampEnterDates(
                db, [a.result.transactionGuid, b.result.transactionGuid],
            );
            expect(count).toBe(2);

            const next = await service.getBeezChanges(context, { since: drained.nextCursor, limit: 500 });
            const guids = next.items.map(item => item.transactionGuid);
            expect(guids).toContain(a.result.transactionGuid);
            expect(guids).toContain(b.result.transactionGuid);

            await service.deleteBeezTransaction(context, actor(), idA, null);
            await service.deleteBeezTransaction(context, actor(), idB, null);
            await dropTransaction(futureGuid);
        });
    });
});
