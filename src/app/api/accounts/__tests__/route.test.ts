/**
 * /api/accounts GET caching tests — Redis-cached hierarchy payload keyed by
 * book + params with an invalidation-indexable date-range tail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const {
    prismaMock,
    requireRoleMock,
    getBookAccountGuidsMock,
    getActiveBookRootGuidMock,
    cacheGetMock,
    cacheSetMock,
    buildPathsMock,
} = vi.hoisted(() => ({
    prismaMock: {
        accounts: { findUnique: vi.fn(), findMany: vi.fn() },
        gnucash_web_account_preferences: { findMany: vi.fn() },
        $queryRaw: vi.fn(),
    },
    requireRoleMock: vi.fn(),
    getBookAccountGuidsMock: vi.fn(),
    getActiveBookRootGuidMock: vi.fn(),
    cacheGetMock: vi.fn(),
    cacheSetMock: vi.fn(),
    buildPathsMock: vi.fn(() => new Map<string, string>()),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/book-scope', () => ({
    getBookAccountGuids: getBookAccountGuidsMock,
    getActiveBookRootGuid: getActiveBookRootGuidMock,
    invalidateBookAccountGuidsCache: vi.fn(),
}));
vi.mock('@/lib/cache', () => ({
    cacheGet: cacheGetMock,
    cacheSet: cacheSetMock,
    cacheInvalidateAllForBook: vi.fn(),
}));
vi.mock('@/lib/data-events', () => ({ publishDataChange: vi.fn() }));
vi.mock('@/lib/gnucash', () => ({ serializeBigInts: (x: unknown) => x }));
vi.mock('@/lib/services/account.service', () => ({
    AccountService: { create: vi.fn() },
    CreateAccountSchema: { safeParse: vi.fn() },
}));
vi.mock('@/lib/account-valuation', () => ({
    buildAccountValuationContext: vi.fn(async () => ({ getMultiplier: () => 1 })),
}));
vi.mock('@/lib/account-path', () => ({ buildBookRelativeAccountPaths: buildPathsMock }));
vi.mock('@prisma/client', () => ({
    Prisma: { sql: vi.fn(() => ({})), empty: {} },
}));

import { GET } from '../route';

const BOOK = 'book-1';
const ROOT = 'r'.repeat(32);
const CHILD = 'a'.repeat(32);

function getRequest(query = ''): NextRequest {
    return { nextUrl: new URL(`http://localhost/api/accounts${query}`) } as unknown as NextRequest;
}

function accountRow(guid: string, overrides: Record<string, unknown> = {}) {
    return {
        guid,
        name: guid === ROOT ? 'Root Account' : 'Assets',
        account_type: guid === ROOT ? 'ROOT' : 'ASSET',
        commodity_guid: 'c'.repeat(32),
        commodity_scu: 100,
        non_std_scu: 0,
        parent_guid: guid === ROOT ? null : ROOT,
        code: '',
        description: '',
        hidden: 0,
        placeholder: 0,
        commodity: { mnemonic: 'USD' },
        ...overrides,
    };
}

beforeEach(() => {
    for (const fn of [
        prismaMock.accounts.findUnique,
        prismaMock.accounts.findMany,
        prismaMock.gnucash_web_account_preferences.findMany,
        prismaMock.$queryRaw,
        requireRoleMock,
        getBookAccountGuidsMock,
        getActiveBookRootGuidMock,
        cacheGetMock,
        cacheSetMock,
    ]) fn.mockReset();
    buildPathsMock.mockClear();

    requireRoleMock.mockResolvedValue({
        user: { id: 1, username: 'u' },
        role: 'readonly',
        bookGuid: BOOK,
    });
    getBookAccountGuidsMock.mockResolvedValue([ROOT, CHILD]);
    getActiveBookRootGuidMock.mockResolvedValue(ROOT);
    prismaMock.accounts.findUnique.mockResolvedValue({ name: 'Root Account' });
    prismaMock.gnucash_web_account_preferences.findMany.mockResolvedValue([]);
    prismaMock.accounts.findMany.mockResolvedValue([accountRow(ROOT), accountRow(CHILD)]);
    cacheGetMock.mockResolvedValue(null);
    cacheSetMock.mockResolvedValue(undefined);
});

describe('GET /api/accounts caching', () => {
    it('serves a cache hit without touching the database', async () => {
        const cachedPayload = [{ guid: CHILD, name: 'Assets (cached)' }];
        cacheGetMock.mockResolvedValue(cachedPayload);

        const res = await GET(getRequest('?noBalances=true'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(cachedPayload);

        expect(getBookAccountGuidsMock).not.toHaveBeenCalled();
        expect(prismaMock.accounts.findMany).not.toHaveBeenCalled();
        expect(cacheSetMock).not.toHaveBeenCalled();
    });

    it('computes and stores on a cache miss with a book-scoped, date-indexed key', async () => {
        const res = await GET(getRequest('?noBalances=true'));
        expect(res.status).toBe(200);
        const payload = await res.json();
        // Root is stripped — response is its children
        expect(payload).toHaveLength(1);
        expect(payload[0].guid).toBe(CHILD);

        expect(cacheGetMock).toHaveBeenCalledTimes(1);
        expect(cacheSetMock).toHaveBeenCalledTimes(1);
        const [key, value, ttl] = cacheSetMock.mock.calls[0];
        // Key: book-scoped, and ends with a date range so cacheSet indexes it
        // for cacheInvalidateAllForBook / cacheInvalidateFrom.
        expect(key).toBe(`cache:${BOOK}:accounts-hierarchy:v1:nobal:_:0001-01-01-9999-12-31`);
        expect(key).toMatch(/:(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})$/);
        expect(value).toEqual(payload);
        expect(ttl).toBe(86400);
    });

    it('keys balance responses separately and includes date params', async () => {
        // avoid the balance SQL path complexities: noBalances=false would run
        // the aggregate — provide an empty result for it
        prismaMock.$queryRaw.mockResolvedValue([]);

        await GET(getRequest('?startDate=2024-01-01&endDate=2024-12-31'));

        const [key] = cacheSetMock.mock.calls[0];
        expect(key).toBe(
            `cache:${BOOK}:accounts-hierarchy:v1:bal:2024-01-01_2024-12-31:2024-01-01-2024-12-31`,
        );
    });

    it('skips the cache entirely in flat mode', async () => {
        prismaMock.$queryRaw.mockResolvedValue([]);

        const res = await GET(getRequest('?flat=true'));
        expect(res.status).toBe(200);
        expect(cacheGetMock).not.toHaveBeenCalled();
        expect(cacheSetMock).not.toHaveBeenCalled();
    });

    it('does not cache when a date param is unparseable', async () => {
        const res = await GET(getRequest('?noBalances=true&startDate=not-a-date'));
        expect(res.status).toBe(200);
        expect(cacheGetMock).not.toHaveBeenCalled();
        expect(cacheSetMock).not.toHaveBeenCalled();
    });
});
