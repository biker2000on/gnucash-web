/**
 * Audit finding S5: the native GnuCash business tables carry no book_guid, so
 * ownership lives in a side table. The load-bearing property is that MISSING
 * ownership means FOREIGN — a gap in the backfill must hide an entity, never
 * expose it to every book.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
    recordEntityOwnership,
    isEntityOwnedByBook,
    assertEntityOwnedByBook,
    listOwnedEntityGuids,
    deleteEntityOwnership,
    deleteOwnedBusinessEntitiesForBook,
    BusinessEntityScopeError,
    type EntityOwnershipClient,
    type EntityTeardownClient,
} from '../entity-ownership';

const BOOK_A = 'a'.repeat(32);
const BOOK_B = 'b'.repeat(32);
const ENTITY = 'c'.repeat(32);

function makeClient(rows: Array<{ entity_type: string; entity_guid: string; book_guid: string }>) {
    const table = [...rows];
    const client: EntityOwnershipClient = {
        gnucash_web_business_entity_ownership: {
            create: vi.fn(async ({ data }) => {
                table.push(data);
                return data;
            }),
            findUnique: vi.fn(async ({ where }) => {
                const key = where.entity_type_entity_guid;
                const hit = table.find(
                    r => r.entity_type === key.entity_type && r.entity_guid === key.entity_guid,
                );
                return hit ? { book_guid: hit.book_guid } : null;
            }),
            findMany: vi.fn(async ({ where }) =>
                table
                    .filter(r => r.entity_type === where.entity_type && r.book_guid === where.book_guid)
                    .map(r => ({ entity_guid: r.entity_guid })),
            ),
            deleteMany: vi.fn(async ({ where }) => {
                for (let i = table.length - 1; i >= 0; i--) {
                    if (table[i].entity_type === where.entity_type && table[i].entity_guid === where.entity_guid) {
                        table.splice(i, 1);
                    }
                }
                return { count: 1 };
            }),
        },
    };
    return { client, table };
}

beforeEach(() => vi.clearAllMocks());

describe('business entity ownership', () => {
    it('treats an unowned entity as foreign, not as public', async () => {
        const { client } = makeClient([]);
        expect(await isEntityOwnedByBook('customer', ENTITY, BOOK_A, client)).toBe(false);
        expect(await isEntityOwnedByBook('customer', ENTITY, BOOK_B, client)).toBe(false);
    });

    it('recognises the owning book and only that book', async () => {
        const { client } = makeClient([
            { entity_type: 'customer', entity_guid: ENTITY, book_guid: BOOK_A },
        ]);
        expect(await isEntityOwnedByBook('customer', ENTITY, BOOK_A, client)).toBe(true);
        expect(await isEntityOwnedByBook('customer', ENTITY, BOOK_B, client)).toBe(false);
    });

    it('does not confuse entity types that share a guid', async () => {
        const { client } = makeClient([
            { entity_type: 'customer', entity_guid: ENTITY, book_guid: BOOK_A },
        ]);
        expect(await isEntityOwnedByBook('vendor', ENTITY, BOOK_A, client)).toBe(false);
    });

    it('assert throws for a foreign entity and is silent for an owned one', async () => {
        const { client } = makeClient([
            { entity_type: 'invoice', entity_guid: ENTITY, book_guid: BOOK_A },
        ]);
        await expect(assertEntityOwnedByBook('invoice', ENTITY, BOOK_B, client))
            .rejects.toBeInstanceOf(BusinessEntityScopeError);
        await expect(assertEntityOwnedByBook('invoice', ENTITY, BOOK_A, client))
            .resolves.toBeUndefined();
    });

    it('lists only the requesting book\'s guids', async () => {
        const { client } = makeClient([
            { entity_type: 'customer', entity_guid: 'x'.repeat(32), book_guid: BOOK_A },
            { entity_type: 'customer', entity_guid: 'y'.repeat(32), book_guid: BOOK_B },
            { entity_type: 'vendor', entity_guid: 'z'.repeat(32), book_guid: BOOK_A },
        ]);
        expect(await listOwnedEntityGuids('customer', BOOK_A, client)).toEqual(['x'.repeat(32)]);
        expect(await listOwnedEntityGuids('customer', BOOK_B, client)).toEqual(['y'.repeat(32)]);
    });

    it('returns an empty list rather than everything when a book owns none', async () => {
        const { client } = makeClient([
            { entity_type: 'customer', entity_guid: 'x'.repeat(32), book_guid: BOOK_A },
        ]);
        // Callers must treat [] as "no results", never as "no filter".
        expect(await listOwnedEntityGuids('customer', BOOK_B, client)).toEqual([]);
    });

    it('records and removes ownership', async () => {
        const { client, table } = makeClient([]);
        await recordEntityOwnership('job', ENTITY, BOOK_A, client);
        expect(await isEntityOwnedByBook('job', ENTITY, BOOK_A, client)).toBe(true);

        await deleteEntityOwnership('job', ENTITY, client);
        expect(await isEntityOwnedByBook('job', ENTITY, BOOK_A, client)).toBe(false);
        expect(table).toHaveLength(0);
    });
});

/**
 * Book teardown ordering. None of the native business tables have foreign keys
 * (verified against the live schema), so nothing cascades: a child row that is
 * not named explicitly, or is deleted after its parent, is orphaned or left
 * parentless if the delete is interrupted. These tests pin the ORDER of the
 * issued statements, not merely their presence.
 */
function makeTeardownClient() {
    const statements: string[] = [];
    const params: unknown[][] = [];
    const db: EntityTeardownClient = {
        $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
            statements.push(sql.replace(/\s+/g, ' ').trim());
            params.push(values);
            return 0;
        },
    };
    return { db, statements, params };
}

/** Index of the first statement deleting FROM `table` (word-boundary exact). */
function indexOfDelete(statements: string[], table: string, columnFilter?: string): number {
    return statements.findIndex(sql => {
        if (!new RegExp(`^DELETE FROM ${table}\\b`).test(sql)) return false;
        return columnFilter ? new RegExp(`WHERE ${columnFilter}\\b`).test(sql) : true;
    });
}

describe('deleteOwnedBusinessEntitiesForBook', () => {
    it('deletes bill-attached entries, and does so before the invoices row', async () => {
        // A vendor BILL is an `invoices` row (owner_type = vendor) whose line
        // items are `entries` with bill = <invoice guid> and invoice NULL.
        const { db, statements } = makeTeardownClient();
        await deleteOwnedBusinessEntitiesForBook(db, BOOK_A);

        const byBill = indexOfDelete(statements, 'entries', 'bill');
        const byInvoice = indexOfDelete(statements, 'entries', 'invoice');
        const byOrder = indexOfDelete(statements, 'entries', 'order_guid');
        const invoices = indexOfDelete(statements, 'invoices');
        const orders = indexOfDelete(statements, 'orders');

        expect(byBill, 'entries reached via entries.bill must be deleted').toBeGreaterThanOrEqual(0);
        expect(invoices).toBeGreaterThanOrEqual(0);
        expect(byBill).toBeLessThan(invoices);
        expect(byInvoice).toBeLessThan(invoices);
        expect(byOrder).toBeLessThan(orders);

        // The bill sweep resolves against the book's OWNED INVOICE guids —
        // a vendor bill is an invoices row, so 'invoice' is the ownership type.
        expect(statements[byBill]).toContain("entity_type = 'invoice'");
    });

    it('deletes taxtable_entries before their taxtables row', async () => {
        // taxtable_entries has no FK to taxtables, so nothing cascades.
        const { db, statements } = makeTeardownClient();
        await deleteOwnedBusinessEntitiesForBook(db, BOOK_A);

        const entries = indexOfDelete(statements, 'taxtable_entries');
        const taxtables = indexOfDelete(statements, 'taxtables');
        expect(entries, 'taxtable_entries must be deleted').toBeGreaterThanOrEqual(0);
        expect(taxtables).toBeGreaterThanOrEqual(0);
        expect(entries).toBeLessThan(taxtables);
        expect(statements[entries]).toContain("entity_type = 'taxtable'");
    });

    it('keeps the full child-first ordering the XML importer uses', async () => {
        const { db, statements } = makeTeardownClient();
        await deleteOwnedBusinessEntitiesForBook(db, BOOK_A);

        const at = (t: string) => indexOfDelete(statements, t);
        // entries -> invoices/orders -> jobs -> contacts -> taxtables/billterms
        expect(at('entries')).toBeLessThan(at('invoices'));
        expect(at('invoices')).toBeLessThan(at('jobs'));
        expect(at('orders')).toBeLessThan(at('jobs'));
        expect(at('jobs')).toBeLessThan(at('customers'));
        expect(at('jobs')).toBeLessThan(at('vendors'));
        expect(at('jobs')).toBeLessThan(at('employees'));

        // Ownership rows go LAST: they are the only record of which book owns
        // the native rows, so dropping them early strands those rows forever.
        const ownership = indexOfDelete(statements, 'gnucash_web_business_entity_ownership');
        expect(ownership).toBe(statements.length - 1);
    });

    it('passes the book guid as a bound parameter and interpolates only literal types', async () => {
        const { db, statements, params } = makeTeardownClient();
        await deleteOwnedBusinessEntitiesForBook(db, BOOK_A);

        for (const [i, sql] of statements.entries()) {
            expect(sql, 'book guid must never be interpolated').not.toContain(BOOK_A);
            expect(sql).toContain('$1');
            expect(params[i]).toEqual([BOOK_A]);
        }
    });
});
