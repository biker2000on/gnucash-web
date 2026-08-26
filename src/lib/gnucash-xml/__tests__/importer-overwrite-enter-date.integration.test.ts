/**
 * The XML importer's OVERWRITE path and the beez change feed, against a REAL
 * PostgreSQL server.
 *
 * WHAT NEEDS A DATABASE. The finding is entirely about the interaction of two
 * subsystems that share one column. `importGnuCashData(..., {overwrite: true})`
 * deletes the colliding transactions and re-inserts them with the `enter_date`
 * the XML snapshot carries — a value that can be years old — while every beez
 * artefact survives the import untouched: the tokens, the external links, and
 * the cursors already in a sync client's hands. Whether the feed then delivers
 * the re-inserted row is a fact about SQL ordering over real rows against a
 * real cursor, and a mocked Prisma client can only prove that some object was
 * passed to a spy.
 *
 * DATA. This tier never truncates (see vitest.integration.config.ts). Every row
 * written here carries this run's uuid in its guid, and afterAll deletes
 * exactly those rows.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestPool } from '../../../__tests__/integration/db';
import { hasTestDatabaseUrl } from '../../../__tests__/integration/env';
import type { GnuCashXmlData } from '../types';

const HAS_TEST_DATABASE = hasTestDatabaseUrl();

const RUN_ID = randomUUID().replace(/-/g, '');

/** GnuCash guid columns are VARCHAR(32); a dash-stripped uuid is exactly 32. */
function testGuid(): string {
    return randomUUID().replace(/-/g, '');
}

const BOOK_GUID = testGuid();
const XML_ROOT_GUID = testGuid();
const BANK_GUID = testGuid();
const EXPENSE_GUID = testGuid();
const TX_GUID = testGuid();
const SPLIT_A_GUID = testGuid();
const SPLIT_B_GUID = testGuid();

/** Lazily imported so nothing in src/lib is evaluated when the suite skips. */
let importer: typeof import('../importer');
let service: typeof import('@/lib/services/beez-sync.service');
let bookScope: typeof import('@/lib/book-scope');
let beez: typeof import('@/lib/integrations/beez');

/**
 * The currency this book is denominated in. Deliberately run-scoped rather
 * than plain USD: db-init puts a unique index on (namespace, mnemonic), and a
 * concurrent run creating its own USD would collide on it.
 */
const MNEMONIC = `X${RUN_ID.slice(0, 6)}`;

/**
 * A one-transaction book, with the `enter_date` the caller dictates.
 *
 * `dateEntered` is the field under test: the importer copies it verbatim into
 * `transactions.enter_date`, which is the feed's ordering key.
 */
function bookData(dateEntered: string, description: string): GnuCashXmlData {
    return {
        book: { id: BOOK_GUID, idType: 'guid' },
        commodities: [
            { space: 'CURRENCY', id: MNEMONIC, name: 'Test Dollar', fraction: 100 },
        ],
        pricedb: [],
        accounts: [
            {
                name: `Root ${RUN_ID.slice(0, 8)}`, id: XML_ROOT_GUID, type: 'ROOT',
                commodity: { space: 'CURRENCY', id: MNEMONIC },
            },
            {
                name: 'Checking', id: BANK_GUID, type: 'BANK', parentId: XML_ROOT_GUID,
                commodity: { space: 'CURRENCY', id: MNEMONIC }, commodityScu: 100,
            },
            {
                name: 'Bee Supplies', id: EXPENSE_GUID, type: 'EXPENSE', parentId: XML_ROOT_GUID,
                commodity: { space: 'CURRENCY', id: MNEMONIC }, commodityScu: 100,
            },
        ],
        transactions: [
            {
                id: TX_GUID,
                currency: { space: 'CURRENCY', id: MNEMONIC },
                datePosted: '2026-08-25 00:00:00 +0000',
                dateEntered,
                description,
                splits: [
                    {
                        id: SPLIT_A_GUID, reconciledState: 'n', value: '2500/100',
                        quantity: '2500/100', accountId: EXPENSE_GUID,
                    },
                    {
                        id: SPLIT_B_GUID, reconciledState: 'n', value: '-2500/100',
                        quantity: '-2500/100', accountId: BANK_GUID,
                    },
                ],
            },
        ],
        budgets: [],
        countData: {},
    };
}

/** Deletes exactly this run's rows, children first. */
async function cleanup(): Promise<void> {
    const pool = getTestPool();
    const book = await pool.query<{ root_account_guid: string; root_template_guid: string }>(
        `SELECT root_account_guid, root_template_guid FROM books WHERE guid = $1`,
        [BOOK_GUID],
    );
    await pool.query(`DELETE FROM slots WHERE obj_guid = ANY($1::text[])`,
        [[BOOK_GUID, TX_GUID, SPLIT_A_GUID, SPLIT_B_GUID]]);
    await pool.query(`DELETE FROM gnucash_web_external_links WHERE book_guid = $1`, [BOOK_GUID]);
    await pool.query(`DELETE FROM gnucash_web_transaction_meta WHERE transaction_guid = $1`, [TX_GUID]);
    await pool.query(`DELETE FROM splits WHERE tx_guid = $1`, [TX_GUID]);
    await pool.query(`DELETE FROM transactions WHERE guid = $1`, [TX_GUID]);
    await pool.query(`DELETE FROM books WHERE guid = $1`, [BOOK_GUID]);
    const accountGuids = [BANK_GUID, EXPENSE_GUID, XML_ROOT_GUID];
    for (const row of book.rows) {
        accountGuids.push(row.root_account_guid, row.root_template_guid);
    }
    await pool.query(`DELETE FROM accounts WHERE guid = ANY($1::text[])`, [accountGuids]);
    await pool.query(`DELETE FROM commodities WHERE namespace = 'CURRENCY' AND mnemonic = $1`, [MNEMONIC]);
}

describe.skipIf(!HAS_TEST_DATABASE)('XML overwrite import and the beez change feed', () => {
    beforeAll(async () => {
        importer = await import('../importer');
        service = await import('@/lib/services/beez-sync.service');
        bookScope = await import('@/lib/book-scope');
        beez = await import('@/lib/integrations/beez');
    });

    afterAll(async () => {
        await cleanup();
    });

    it('re-stamps an overwritten transaction so a cursor issued before the import still delivers it', async () => {
        // A first import: no book here yet, so nothing can hold a cursor naming
        // one of these rows, and the XML's own history is what the caller
        // asked to reconstruct. That value is kept verbatim.
        const historical = '2019-03-04 08:15:00 +0000';
        await importer.importGnuCashData(bookData(historical, 'Original description'), 'Overwrite Test');
        bookScope.invalidateBookAccountGuidsCache();

        const fresh = await getTestPool().query<{ enter_date: string }>(
            `SELECT to_char(enter_date, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS enter_date
             FROM transactions WHERE guid = $1`,
            [TX_GUID],
        );
        expect(fresh.rows[0].enter_date, 'a fresh import keeps its history').toMatch(/^2019-03-04T/);

        // A sync client catches up and holds a cursor. Its watermark is at the
        // database clock, years above the row it just consumed.
        const context = await service.getBeezBookContext(BOOK_GUID);
        const caughtUp = await service.getBeezChanges(context, { since: null, limit: 500 });
        expect(caughtUp.items.map(i => i.transactionGuid)).toContain(TX_GUID);
        const beforeImport = caughtUp.nextCursor as string;
        expect(beforeImport).toBeTruthy();
        const emittedOnce = caughtUp.items.find(i => i.transactionGuid === TX_GUID);

        // Now the same book is re-imported over itself with a CHANGED payload
        // and the same years-old dateEntered. Before the re-stamp this row
        // landed back at 2019 — below the cursor above, below every overlap
        // band there could ever be, and therefore never delivered again. Worse,
        // its `(transactionGuid, enterDate)` pair was unchanged, so a consumer
        // obeying the wire contract's dedup rule would DISCARD the new payload
        // even if it did arrive.
        await importer.importGnuCashData(
            bookData(historical, 'Description after the overwrite'),
            'Overwrite Test',
            { overwrite: true },
        );
        bookScope.invalidateBookAccountGuidsCache();

        const restamped = await getTestPool().query<{ enter_date: string; description: string }>(
            `SELECT to_char(enter_date, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS enter_date, description
             FROM transactions WHERE guid = $1`,
            [TX_GUID],
        );
        expect(restamped.rows[0].description).toBe('Description after the overwrite');
        expect(restamped.rows[0].enter_date, 'the overwrite must not restore 2019')
            .not.toMatch(/^2019-/);

        // The cursor from before the import delivers the changed row, and the
        // dedup key moved with the payload.
        const after = await service.getBeezChanges(context, { since: beforeImport, limit: 500 });
        const delivered = after.items.find(i => i.transactionGuid === TX_GUID);
        expect(delivered, 'an overwritten row must reach a client that was caught up').toBeDefined();
        expect(delivered?.description).toBe('Description after the overwrite');
        expect(delivered?.enterDate).not.toBe(emittedOnce?.enterDate);
        expect(delivered?.enterDate).toBe(`${restamped.rows[0].enter_date}Z`);
        // And it is a real position in the ordered stream, not the quarantine
        // set papering over a stamp beyond the horizon.
        expect(delivered?.quarantined).toBeUndefined();
        expect(beez.decodeChangesCursor(after.nextCursor as string)?.enterDate).toBeTruthy();
    });
});
