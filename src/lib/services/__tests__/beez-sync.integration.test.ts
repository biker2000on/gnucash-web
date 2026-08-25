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

describe.skipIf(!HAS_TEST_DATABASE)('beez-trackz sync round trip', () => {
    beforeAll(async () => {
        service = await import('../beez-sync.service');
        bookScope = await import('@/lib/book-scope');
        beez = await import('@/lib/integrations/beez');
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
            const stamp = '2027-03-04 05:06:07.123456';
            await pool.query(
                `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
                 VALUES ($1, $2, '', NOW(), $3::timestamp, 'Microsecond boundary')`,
                [txGuid, USD_GUID, stamp],
            );
            await insertBalancedSplits(txGuid, 100);

            const feed = await service.getBeezChanges(context, { since: null, limit: 500 });
            const item = feed.items.find(entry => entry.transactionGuid === txGuid);
            expect(item).toBeDefined();
            // The payload carries the microseconds too, not a truncated Date.
            expect(item?.enterDate).toBe('2027-03-04T05:06:07.123456Z');

            const again = await service.getBeezChanges(context, { since: feed.nextCursor, limit: 500 });
            expect(again.items.map(i => i.transactionGuid)).not.toContain(txGuid);

            // And a third poll from the same place is still quiet: the watermark
            // is stable, not merely advanced once.
            const third = await service.getBeezChanges(context, { since: again.nextCursor, limit: 500 });
            expect(third.items.map(i => i.transactionGuid)).not.toContain(txGuid);

            // Its enter_date is deliberately in the future so it sorts last and
            // the cursor lands exactly on it. Drop it again so it does not sit
            // ahead of every row a later test writes.
            await dropTransaction(txGuid);
        });

        it('pages five rows across three pages of two without skipping or duplicating', async () => {
            // Start from a drained cursor so only the five rows below are in
            // play, whatever else this suite has already written.
            const drained = await service.getBeezChanges(context, { since: null, limit: 500 });
            expect(drained.hasMore).toBe(false);

            const expected: string[] = [];
            for (let index = 0; index < 5; index += 1) {
                const created = await service.createBeezTransaction(
                    context, actor(), parsed(`${RUN_ID}-page-${index}`, 100 + index), null,
                );
                expected.push(created.result.transactionGuid);
            }

            const seen: string[] = [];
            let cursor = drained.nextCursor;
            for (let page = 0; page < 3; page += 1) {
                const response = await service.getBeezChanges(context, { since: cursor, limit: 2 });
                // The always-emitted sets ride along on every page and are
                // identified by a null enterDate or the deleted flag; only the
                // ordered page is bounded by `limit`.
                const ordered = response.items.filter(item => !item.deleted && item.enterDate !== null);
                expect(ordered.length, `page ${page}`).toBe(page < 2 ? 2 : 1);
                seen.push(...ordered.map(item => item.transactionGuid as string));
                cursor = response.nextCursor;
                expect(response.hasMore, `page ${page}`).toBe(page < 2);
            }

            // Every row exactly once: no gap across a page boundary, no repeat.
            // Compared as sets because two creates can land in the same
            // millisecond, in which case guid — not creation order — decides.
            expect(new Set(seen).size).toBe(5);
            expect([...seen].sort()).toEqual([...expected].sort());

            const after = await service.getBeezChanges(context, { since: cursor, limit: 2 });
            expect(after.items.filter(i => !i.deleted && i.enterDate !== null)).toEqual([]);
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

        it('returns the caller cursor unchanged when there is nothing new', async () => {
            const all = await service.getBeezChanges(context, { since: null, limit: 500 });
            expect(all.hasMore).toBe(false);
            const empty = await service.getBeezChanges(context, { since: all.nextCursor, limit: 500 });
            // The ordered stream is exhausted. The always-emitted sets — NULL
            // enter_date rows and tombstones — ride along regardless, which is
            // what keeps them from being lost, so they are excluded here.
            expect(empty.items.filter(item => !item.deleted && item.enterDate !== null)).toEqual([]);
            expect(empty.nextCursor).toBe(all.nextCursor);
            expect(empty.hasMore).toBe(false);
        });
    });
});
