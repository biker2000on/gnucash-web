import { describe, it, expect, vi, beforeEach } from 'vitest';

const { savedReports } = vi.hoisted(() => ({
    savedReports: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    },
}));

vi.mock('@/lib/prisma', () => ({
    default: {
        gnucash_web_saved_reports: savedReports,
    },
}));

import {
    listSavedReports,
    getStarredReports,
    getSavedReport,
    createSavedReport,
    updateSavedReport,
    deleteSavedReport,
    toggleStar,
    extractAccountGuidsFromConfig,
} from '../saved-reports';

const BOOK = 'b'.repeat(32);
const OTHER_BOOK = 'c'.repeat(32);
const USER = 1;
const OTHER_USER = 2;

interface Row {
    id: number;
    user_id: number | null;
    book_guid: string | null;
    base_report_type: string;
    name: string;
    description: string | null;
    config: Record<string, unknown>;
    filters: Record<string, unknown> | null;
    is_starred: boolean;
    created_at: Date;
    updated_at: Date;
}

function row(id: number, book_guid: string | null, overrides: Partial<Row> = {}): Row {
    return {
        id,
        user_id: USER,
        book_guid,
        base_report_type: 'balance_sheet',
        name: `Report ${id}`,
        description: null,
        config: {},
        filters: null,
        is_starred: false,
        created_at: new Date('2026-07-01T00:00:00Z'),
        updated_at: new Date('2026-07-01T00:00:00Z'),
        ...overrides,
    };
}

/** Mimic prisma equality semantics: where.book_guid = X never matches NULL rows. */
function applyWhere(rows: Row[], where: Record<string, unknown>): Row[] {
    return rows.filter(r => {
        if ('user_id' in where && r.user_id !== where.user_id) return false;
        if ('book_guid' in where && r.book_guid !== where.book_guid) return false;
        if ('is_starred' in where && r.is_starred !== where.is_starred) return false;
        return true;
    });
}

beforeEach(() => {
    for (const fn of Object.values(savedReports)) fn.mockReset();
});

describe('listSavedReports book scoping', () => {
    it('returns only the active book\'s rows, excluding other-book and NULL rows', async () => {
        const rows = [
            row(1, BOOK),
            row(2, OTHER_BOOK),
            row(3, null), // pre-backfill legacy row — hidden until backfill runs
            row(4, BOOK, { user_id: OTHER_USER }),
        ];
        savedReports.findMany.mockImplementation(
            async ({ where }: { where: Record<string, unknown> }) => applyWhere(rows, where));

        const result = await listSavedReports(USER, BOOK);

        expect(result.map(r => r.id)).toEqual([1]);
        // The where clause itself carries both filters
        expect(savedReports.findMany.mock.calls[0][0].where).toEqual({
            user_id: USER,
            book_guid: BOOK,
        });
    });

    it('getStarredReports combines user, book, and starred filters', async () => {
        const rows = [
            row(1, BOOK, { is_starred: true }),
            row(2, OTHER_BOOK, { is_starred: true }),
            row(3, BOOK, { is_starred: false }),
        ];
        savedReports.findMany.mockImplementation(
            async ({ where }: { where: Record<string, unknown> }) => applyWhere(rows, where));

        const result = await getStarredReports(USER, BOOK);

        expect(result.map(r => r.id)).toEqual([1]);
        expect(savedReports.findMany.mock.calls[0][0].where.book_guid).toBe(BOOK);
    });
});

describe('cross-book single-row access', () => {
    it('getSavedReport returns null for a report in another book', async () => {
        savedReports.findUnique.mockResolvedValue(row(5, OTHER_BOOK));

        expect(await getSavedReport(5, USER, BOOK)).toBeNull();
    });

    it('getSavedReport returns the report when the book matches', async () => {
        savedReports.findUnique.mockResolvedValue(row(5, BOOK));

        const report = await getSavedReport(5, USER, BOOK);
        expect(report?.id).toBe(5);
        expect(report?.bookGuid).toBe(BOOK);
    });

    it('getSavedReport still enforces ownership when the book check is skipped', async () => {
        savedReports.findUnique.mockResolvedValue(row(5, OTHER_BOOK, { user_id: OTHER_USER }));

        expect(await getSavedReport(5, USER)).toBeNull();
    });

    it('getSavedReport without a book (scheduler path) returns any of the user\'s books', async () => {
        savedReports.findUnique.mockResolvedValue(row(5, OTHER_BOOK));

        const report = await getSavedReport(5, USER);
        expect(report?.id).toBe(5);
    });

    it('updateSavedReport refuses a report in another book and never writes', async () => {
        savedReports.findUnique.mockResolvedValue(row(6, OTHER_BOOK));

        const result = await updateSavedReport(6, USER, BOOK, { name: 'Renamed' });

        expect(result).toBeNull();
        expect(savedReports.update).not.toHaveBeenCalled();
    });

    it('deleteSavedReport refuses a report in another book and never deletes', async () => {
        savedReports.findUnique.mockResolvedValue(row(7, OTHER_BOOK));

        expect(await deleteSavedReport(7, USER, BOOK)).toBe(false);
        expect(savedReports.delete).not.toHaveBeenCalled();
    });

    it('toggleStar refuses a report in another book', async () => {
        savedReports.findUnique.mockResolvedValue(row(8, OTHER_BOOK));

        expect(await toggleStar(8, USER, BOOK)).toBeNull();
        expect(savedReports.update).not.toHaveBeenCalled();
    });

    it('updateSavedReport writes when the book matches', async () => {
        savedReports.findUnique.mockResolvedValue(row(9, BOOK));
        savedReports.update.mockResolvedValue(row(9, BOOK, { name: 'Renamed' }));

        const result = await updateSavedReport(9, USER, BOOK, { name: 'Renamed' });

        expect(result?.name).toBe('Renamed');
        expect(savedReports.update).toHaveBeenCalledTimes(1);
    });
});

describe('createSavedReport book stamping', () => {
    it('stamps new reports with the active book guid', async () => {
        savedReports.create.mockImplementation(
            async ({ data }: { data: Record<string, unknown> }) =>
                row(10, data.book_guid as string, { config: data.config as Record<string, unknown> }));

        const report = await createSavedReport(USER, BOOK, {
            baseReportType: 'balance_sheet' as never,
            name: 'New report',
            config: {},
        });

        expect(savedReports.create.mock.calls[0][0].data.book_guid).toBe(BOOK);
        expect(report.bookGuid).toBe(BOOK);
    });
});

describe('extractAccountGuidsFromConfig (backfill guid extraction, TS twin of the SQL)', () => {
    const G1 = '0123456789abcdef0123456789abcdef';
    const G2 = 'fedcba9876543210fedcba9876543210';
    const G3 = 'aaaabbbbccccddddeeeeffff00001111';

    it('prefers the explicit accountGuids array, in order', () => {
        expect(extractAccountGuidsFromConfig({ accountGuids: [G1, G2] })).toEqual([G1, G2]);
    });

    it('falls back to scanning the whole config for 32-hex substrings', () => {
        expect(extractAccountGuidsFromConfig({ budgetGuid: G3, nested: { deep: [G1] } }))
            .toEqual([G3, G1]);
    });

    it('puts explicit accountGuids before fallback matches and dedupes', () => {
        expect(extractAccountGuidsFromConfig({ other: G2, accountGuids: [G1, G1] }))
            .toEqual([G1, G2]);
    });

    it('lowercases guids to match accounts.guid storage', () => {
        expect(extractAccountGuidsFromConfig({ accountGuids: [G1.toUpperCase()] })).toEqual([G1]);
    });

    it('ignores non-guid strings and non-string array entries', () => {
        expect(extractAccountGuidsFromConfig({
            accountGuids: ['not-a-guid', 42, null, G1.slice(0, 31)],
            label: 'Quarterly',
        })).toEqual([]);
    });

    it('returns [] for null and primitive configs', () => {
        expect(extractAccountGuidsFromConfig(null)).toEqual([]);
        expect(extractAccountGuidsFromConfig('text')).toEqual([]);
        expect(extractAccountGuidsFromConfig(undefined)).toEqual([]);
    });
});
