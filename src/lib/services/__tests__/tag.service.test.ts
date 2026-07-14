import { describe, it, expect, vi, beforeEach } from 'vitest';

const { tags, getActiveBookGuidMock } = vi.hoisted(() => ({
    tags: {
        findMany: vi.fn(),
        create: vi.fn(),
    },
    getActiveBookGuidMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    default: {
        gnucash_web_tags: tags,
    },
}));
vi.mock('@/lib/book-scope', () => ({
    getActiveBookGuid: getActiveBookGuidMock,
}));

import { resolveOrCreateTags } from '../tag.service';

const BOOK = 'b'.repeat(32);
const OTHER_BOOK = 'c'.repeat(32);

interface TagRow {
    id: number;
    book_guid: string | null;
    name: string;
    color: string | null;
    description: string | null;
}

/** In-memory tag table honoring the book_guid/name(-in) where shapes the service uses. */
function seed(rows: TagRow[]) {
    let nextId = Math.max(0, ...rows.map(r => r.id)) + 1;
    tags.findMany.mockImplementation(async ({ where }: {
        where?: { book_guid?: string | null; name?: { in: string[] } };
    } = {}) => rows.filter(r => {
        if (where && 'book_guid' in where && r.book_guid !== where.book_guid) return false;
        if (where?.name && !where.name.in.includes(r.name)) return false;
        return true;
    }));
    tags.create.mockImplementation(async ({ data }: {
        data: { book_guid?: string | null; name: string; color?: string | null };
    }) => {
        const created: TagRow = {
            id: nextId++,
            book_guid: data.book_guid ?? null,
            name: data.name,
            color: data.color ?? null,
            description: null,
        };
        rows.push(created);
        return created;
    });
}

beforeEach(() => {
    tags.findMany.mockReset();
    tags.create.mockReset();
    getActiveBookGuidMock.mockReset();
    getActiveBookGuidMock.mockResolvedValue(BOOK);
});

describe('resolveOrCreateTags book scoping', () => {
    it('reuses an existing tag from the active book without creating a duplicate', async () => {
        seed([{ id: 1, book_guid: BOOK, name: 'vacation', color: 'blue', description: null }]);

        const result = await resolveOrCreateTags(['#Vacation']);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ id: 1, name: 'vacation' });
        expect(tags.create).not.toHaveBeenCalled();
        // Lookup was constrained to the active book
        expect(tags.findMany.mock.calls[0][0].where.book_guid).toBe(BOOK);
    });

    it('does NOT reuse another book\'s same-named tag — creates a fresh one in the active book', async () => {
        seed([{ id: 1, book_guid: OTHER_BOOK, name: 'vacation', color: 'blue', description: null }]);

        const result = await resolveOrCreateTags(['vacation']);

        expect(tags.create).toHaveBeenCalledTimes(1);
        expect(tags.create.mock.calls[0][0].data).toMatchObject({
            book_guid: BOOK,
            name: 'vacation',
        });
        expect(result[0].id).not.toBe(1);
    });

    it('creates missing tags under the active book with palette colors drawn from that book only', async () => {
        // Active book has no tags; the other book's colors must not skew the pool
        seed([{ id: 1, book_guid: OTHER_BOOK, name: 'x', color: 'blue', description: null }]);

        const result = await resolveOrCreateTags(['groceries', 'travel']);

        expect(result.map(t => t.name)).toEqual(['groceries', 'travel']);
        expect(tags.create).toHaveBeenCalledTimes(2);
        for (const call of tags.create.mock.calls) {
            expect(call[0].data.book_guid).toBe(BOOK);
        }
        // Color pool query was book-scoped
        const colorPoolCall = tags.findMany.mock.calls[1][0];
        expect(colorPoolCall.where).toEqual({ book_guid: BOOK });
    });

    it('rejects invalid names before touching the database', async () => {
        await expect(resolveOrCreateTags(['not valid!!'])).rejects.toThrow(/Invalid tag name/);
        expect(tags.findMany).not.toHaveBeenCalled();
        expect(tags.create).not.toHaveBeenCalled();
    });
});
