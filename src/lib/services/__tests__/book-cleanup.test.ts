import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Book cleanup tests.
 *
 * The first block is a REGRESSION GUARD: it parses prisma/schema.prisma and
 * fails if any model with a *book_guid column is neither covered by
 * deleteBookExtensionData() nor explicitly listed as an exclusion. Adding a
 * new book-scoped table without extending the cleanup service will fail CI.
 */

const state = vi.hoisted(() => ({
    deleteManyCalls: [] as { model: string; args: unknown }[],
    findManyCalls: [] as { model: string; args: unknown }[],
    rawStatements: [] as string[],
    transactionOps: 0,
}));

vi.mock('@/lib/prisma', () => {
    const modelCache = new Map<string, unknown>();

    const makeModelMock = (model: string) => ({
        deleteMany: (args: unknown) => {
            state.deleteManyCalls.push({ model, args });
            return Promise.resolve({ count: 0 });
        },
        findMany: (args: unknown) => {
            state.findManyCalls.push({ model, args });
            return Promise.resolve([]);
        },
    });

    const prismaMock = new Proxy({}, {
        get(_target, prop: string | symbol) {
            if (typeof prop !== 'string') return undefined;
            if (prop === '$transaction') {
                return async (arg: unknown) => {
                    if (Array.isArray(arg)) {
                        state.transactionOps += arg.length;
                        return Promise.all(arg);
                    }
                    return (arg as (tx: unknown) => Promise<unknown>)(prismaMock);
                };
            }
            if (prop === '$executeRaw') {
                return (strings: TemplateStringsArray) => {
                    state.rawStatements.push(strings.join('?'));
                    return Promise.resolve(0);
                };
            }
            if (prop === '$executeRawUnsafe') {
                return (sql: string) => {
                    state.rawStatements.push(sql);
                    return Promise.resolve(0);
                };
            }
            if (prop === 'then') return undefined; // not a thenable
            if (!modelCache.has(prop)) modelCache.set(prop, makeModelMock(prop));
            return modelCache.get(prop);
        },
    });

    return { default: prismaMock };
});

const storageDelete = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/storage/storage-backend', () => ({
    getStorageBackend: async () => ({ delete: storageDelete }),
}));

import {
    deleteBookExtensionData,
    COVERED_BOOK_GUID_MODELS,
    EXCLUDED_BOOK_GUID_MODELS,
    ACCOUNT_KEYED_MODELS,
    SPLIT_OR_TXN_KEYED_TABLES,
    LAZY_BOOK_GUID_TABLES,
} from '../book-cleanup.service';

const BOOK = 'b'.repeat(32);
const ACCOUNTS = ['a'.repeat(32), 'c'.repeat(32)];

/** Parse prisma/schema.prisma and return model names that have a *book_guid column. */
function schemaModelsWithBookGuidColumn(): string[] {
    const schemaPath = path.join(process.cwd(), 'prisma', 'schema.prisma');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    const models: string[] = [];
    const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
    let match: RegExpExecArray | null;
    while ((match = modelRe.exec(schema)) !== null) {
        const [, name, body] = match;
        // Column definitions only (indented `field Type`), not @@index lines.
        const hasBookGuidColumn = /^\s+(?:\w+_)?book_guid\s+String/m.test(body);
        if (hasBookGuidColumn) models.push(name);
    }
    return models;
}

beforeEach(() => {
    state.deleteManyCalls = [];
    state.findManyCalls = [];
    state.rawStatements = [];
    state.transactionOps = 0;
    storageDelete.mockClear();
});

describe('regression guard: schema coverage', () => {
    it('every model with a book_guid column is covered or explicitly excluded', () => {
        const schemaModels = schemaModelsWithBookGuidColumn();
        expect(schemaModels.length).toBeGreaterThanOrEqual(30); // sanity: parse worked

        const covered = new Set<string>([
            ...COVERED_BOOK_GUID_MODELS,
            ...Object.keys(EXCLUDED_BOOK_GUID_MODELS),
        ]);

        const missing = schemaModels.filter((m) => !covered.has(m));
        expect(
            missing,
            `Models with a book_guid column that deleteBookExtensionData() does not ` +
            `cover: ${missing.join(', ')}. Add them to the cleanup service (or to ` +
            `EXCLUDED_BOOK_GUID_MODELS with a documented reason).`,
        ).toEqual([]);
    });

    it('covered/excluded lists contain no stale models that left the schema', () => {
        const schemaModels = new Set(schemaModelsWithBookGuidColumn());
        const stale = [
            ...COVERED_BOOK_GUID_MODELS,
            ...Object.keys(EXCLUDED_BOOK_GUID_MODELS),
        ].filter((m) => !schemaModels.has(m));
        expect(stale).toEqual([]);
    });

    it('every exclusion documents a reason', () => {
        for (const [model, reason] of Object.entries(EXCLUDED_BOOK_GUID_MODELS)) {
            expect(reason, `exclusion for ${model} needs a reason`).toBeTruthy();
        }
    });
});

describe('deleteBookExtensionData', () => {
    it('issues a book_guid-scoped deleteMany for every covered model', async () => {
        await deleteBookExtensionData(BOOK, ACCOUNTS);

        const deletedModels = new Set(state.deleteManyCalls.map((c) => c.model));
        for (const model of COVERED_BOOK_GUID_MODELS) {
            expect(deletedModels.has(model), `expected deleteMany on ${model}`).toBe(true);
        }

        // Every covered delete filters on the book guid (directly or via OR).
        for (const call of state.deleteManyCalls) {
            if (!(COVERED_BOOK_GUID_MODELS as readonly string[]).includes(call.model)) continue;
            expect(JSON.stringify(call.args), `${call.model} filter must scope to book`)
                .toContain(BOOK);
        }
    });

    it('never touches excluded models (audit history is preserved)', async () => {
        await deleteBookExtensionData(BOOK, ACCOUNTS);

        const deletedModels = new Set(state.deleteManyCalls.map((c) => c.model));
        for (const model of Object.keys(EXCLUDED_BOOK_GUID_MODELS)) {
            expect(deletedModels.has(model), `${model} must NOT be deleted`).toBe(false);
        }
    });

    it('deletes book_links rows where the book appears in either column', async () => {
        await deleteBookExtensionData(BOOK, ACCOUNTS);

        const call = state.deleteManyCalls.find((c) => c.model === 'gnucash_web_book_links');
        expect(call).toBeDefined();
        const where = (call!.args as { where: { OR: Record<string, string>[] } }).where;
        expect(where.OR).toEqual(expect.arrayContaining([
            { business_book_guid: BOOK },
            { household_book_guid: BOOK },
        ]));
    });

    it('cleans account-keyed tables for the book\'s accounts', async () => {
        await deleteBookExtensionData(BOOK, ACCOUNTS);

        const directAccountKeyed = ['gnucash_web_account_preferences', 'gnucash_web_tax_mappings', 'gnucash_web_depreciation_schedules'];
        for (const model of directAccountKeyed) {
            const call = state.deleteManyCalls.find((c) => c.model === model);
            expect(call, `expected deleteMany on ${model}`).toBeDefined();
            expect(call!.args).toEqual({ where: { account_guid: { in: ACCOUNTS } } });
        }

        // Junction tables reached via relations AND account guids
        for (const model of ['gnucash_web_account_tags', 'gnucash_web_account_funds']) {
            const call = state.deleteManyCalls.find((c) => c.model === model);
            expect(call, `expected deleteMany on ${model}`).toBeDefined();
            const json = JSON.stringify(call!.args);
            expect(json).toContain(BOOK);
            expect(json).toContain(ACCOUNTS[0]);
        }

        // Sanity: all documented account-keyed models were exercised
        const deletedModels = new Set(state.deleteManyCalls.map((c) => c.model));
        for (const model of ACCOUNT_KEYED_MODELS) {
            expect(deletedModels.has(model), `expected deleteMany on ${model}`).toBe(true);
        }
    });

    it('cleans split/transaction-keyed and lazy tables via raw SQL', async () => {
        await deleteBookExtensionData(BOOK, ACCOUNTS);

        const allRaw = state.rawStatements.join('\n');
        for (const table of [...SPLIT_OR_TXN_KEYED_TABLES, ...LAZY_BOOK_GUID_TABLES]) {
            expect(allRaw, `expected raw DELETE against ${table}`).toContain(table);
        }
    });

    it('cascade children are deleted via their parent relations', async () => {
        await deleteBookExtensionData(BOOK, ACCOUNTS);

        const deletedModels = new Set(state.deleteManyCalls.map((c) => c.model));
        for (const junction of [
            'gnucash_web_meeting_attendance',
            'gnucash_web_package_redemptions',
            'gnucash_web_estimate_lines',
            'gnucash_web_simplefin_account_map',
            'gnucash_web_transaction_tags',
        ]) {
            expect(deletedModels.has(junction), `expected deleteMany on ${junction}`).toBe(true);
        }
    });

    it('deletes stored files for receipts, payslips, entity documents, and home item photos', async () => {
        await deleteBookExtensionData(BOOK, ACCOUNTS);

        const queriedModels = new Set(state.findManyCalls.map((c) => c.model));
        expect(queriedModels.has('gnucash_web_receipts')).toBe(true);
        expect(queriedModels.has('gnucash_web_payslips')).toBe(true);
        expect(queriedModels.has('gnucash_web_entity_documents')).toBe(true);
        expect(queriedModels.has('gnucash_web_home_item_photos')).toBe(true);
        // findMany returns [] in this mock, so nothing to delete
        expect(storageDelete).not.toHaveBeenCalled();
    });

    it('skips account/split-keyed deletes when the account list is empty without throwing', async () => {
        await deleteBookExtensionData(BOOK, []);

        const deletedModels = new Set(state.deleteManyCalls.map((c) => c.model));
        expect(deletedModels.has('gnucash_web_account_preferences')).toBe(false);
        expect(deletedModels.has('gnucash_web_tax_mappings')).toBe(false);
        expect(deletedModels.has('gnucash_web_depreciation_schedules')).toBe(false);
        const allRaw = state.rawStatements.join('\n');
        expect(allRaw).not.toContain('gnucash_web_contribution_tax_year');
        // Book-guid-keyed tables are still cleaned
        expect(deletedModels.has('gnucash_web_book_settings')).toBe(true);
    });
});
