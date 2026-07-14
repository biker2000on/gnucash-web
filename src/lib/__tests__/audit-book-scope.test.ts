import { describe, it, expect, vi, beforeEach } from 'vitest';

const { audit, getActiveBookGuidMock, getCurrentUserMock } = vi.hoisted(() => ({
    audit: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
    },
    getActiveBookGuidMock: vi.fn(),
    getCurrentUserMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    default: {
        gnucash_web_audit: audit,
    },
}));
vi.mock('@/lib/auth', () => ({
    getCurrentUser: getCurrentUserMock,
}));
vi.mock('@/lib/book-scope', () => ({
    getActiveBookGuid: getActiveBookGuidMock,
}));

import { logAudit, listAuditEntries, undoAuditEntry } from '../services/audit.service';

const BOOK = 'b'.repeat(32);
const OTHER_BOOK = 'c'.repeat(32);

interface Row {
    id: number;
    user_id: number | null;
    book_guid: string | null;
    action: string;
    entity_type: string;
    entity_guid: string;
    old_values: unknown;
    new_values: unknown;
    created_at: Date;
    user: { username: string; display_name: string | null } | null;
}

function row(id: number, book_guid: string | null, overrides: Partial<Row> = {}): Row {
    return {
        id,
        user_id: null,
        book_guid,
        action: 'UPDATE',
        entity_type: 'ACCOUNT',
        entity_guid: 'a'.repeat(32),
        old_values: { name: 'Before' },
        new_values: { name: 'After' },
        created_at: new Date('2026-07-01T00:00:00Z'),
        user: null,
        ...overrides,
    };
}

/** Mimic prisma equality semantics: where.book_guid = X never matches NULL rows. */
function applyWhere(rows: Row[], where: Record<string, unknown>): Row[] {
    return rows.filter(r => {
        if ('book_guid' in where && r.book_guid !== where.book_guid) return false;
        if ('entity_type' in where && r.entity_type !== where.entity_type) return false;
        if ('action' in where && r.action !== where.action) return false;
        if ('entity_guid' in where && r.entity_guid !== where.entity_guid) return false;
        return true;
    });
}

function seedListMocks(rows: Row[]) {
    audit.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        applyWhere(rows, where));
    audit.count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        applyWhere(rows, where).length);
}

beforeEach(() => {
    for (const fn of Object.values(audit)) fn.mockReset();
    getActiveBookGuidMock.mockReset();
    getCurrentUserMock.mockReset();
    getCurrentUserMock.mockResolvedValue(null);
});

describe('logAudit book attribution', () => {
    it('stamps entries with the active book guid', async () => {
        getActiveBookGuidMock.mockResolvedValue(BOOK);
        audit.create.mockResolvedValue({});

        await logAudit('CREATE', 'TRANSACTION', 't'.repeat(32), null, { description: 'x' });

        expect(audit.create).toHaveBeenCalledTimes(1);
        expect(audit.create.mock.calls[0][0].data.book_guid).toBe(BOOK);
    });

    it('falls back to null book_guid when book resolution fails (entry still written)', async () => {
        getActiveBookGuidMock.mockRejectedValue(new Error('NO_BOOKS'));
        audit.create.mockResolvedValue({});

        await logAudit('DELETE', 'TRANSACTION', 't'.repeat(32), { description: 'x' }, null);

        expect(audit.create).toHaveBeenCalledTimes(1);
        expect(audit.create.mock.calls[0][0].data.book_guid).toBeNull();
    });
});

describe('listAuditEntries book scoping', () => {
    it('returns only the requested book\'s rows, excluding NULL and other-book rows', async () => {
        seedListMocks([
            row(1, BOOK),
            row(2, OTHER_BOOK),
            row(3, null), // unattributable legacy row — must stay hidden
        ]);

        const result = await listAuditEntries({ bookGuid: BOOK });

        expect(result.total).toBe(1);
        expect(result.entries.map(e => e.id)).toEqual([1]);
        // The where clause itself carries the book filter for both queries
        expect(audit.findMany.mock.calls[0][0].where.book_guid).toBe(BOOK);
        expect(audit.count.mock.calls[0][0].where.book_guid).toBe(BOOK);
    });

    it('combines the book filter with entity/action filters', async () => {
        seedListMocks([
            row(1, BOOK, { entity_type: 'TRANSACTION', action: 'DELETE' }),
            row(2, BOOK, { entity_type: 'ACCOUNT', action: 'DELETE' }),
            row(3, OTHER_BOOK, { entity_type: 'TRANSACTION', action: 'DELETE' }),
        ]);

        const result = await listAuditEntries({
            bookGuid: BOOK,
            entityType: 'TRANSACTION',
            action: 'DELETE',
        });

        expect(result.total).toBe(1);
        expect(result.entries[0].id).toBe(1);
    });
});

describe('undoAuditEntry book check', () => {
    it('refuses to undo an entry belonging to another book', async () => {
        audit.findUnique.mockResolvedValue(row(5, OTHER_BOOK, {
            entity_type: 'TRANSACTION',
            action: 'CREATE',
        }));

        const result = await undoAuditEntry(5, BOOK);

        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/not found/i);
    });

    it('refuses to undo an unattributable entry (NULL book_guid)', async () => {
        audit.findUnique.mockResolvedValue(row(6, null, {
            entity_type: 'TRANSACTION',
            action: 'CREATE',
        }));

        const result = await undoAuditEntry(6, BOOK);

        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/not found/i);
    });

    it('passes the book gate for a matching entry (fails later for entity type, not book)', async () => {
        audit.findUnique.mockResolvedValue(row(7, BOOK, { entity_type: 'ACCOUNT' }));

        const result = await undoAuditEntry(7, BOOK);

        expect(result.ok).toBe(false);
        // Proves the book check passed: the failure is the undo-plan reason
        expect(result.message).toMatch(/transaction entries/i);
    });
});
