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
    BusinessEntityScopeError,
    type EntityOwnershipClient,
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
