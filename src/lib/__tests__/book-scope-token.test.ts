/**
 * Regression test for audit finding S4 (docs/audit-2026-08-03.md).
 *
 * Bearer-token requests carry no cookie, so `session.activeBookGuid` is
 * undefined. The scope helpers used to fall back to `books.findFirst()`, which
 * meant a token issued for book B read book A's data — while `requireRole` had
 * authorized only book B.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    queryRawMock,
    findUniqueMock,
    findFirstMock,
    getSessionMock,
    headersMock,
    authenticateBearerMock,
} = vi.hoisted(() => ({
    queryRawMock: vi.fn(),
    findUniqueMock: vi.fn(),
    findFirstMock: vi.fn(),
    getSessionMock: vi.fn(),
    headersMock: vi.fn(),
    authenticateBearerMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: queryRawMock,
        books: { findUnique: findUniqueMock, findFirst: findFirstMock },
    },
}));
vi.mock('@/lib/auth', () => ({ getSession: getSessionMock }));
vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('@/lib/api-tokens', () => ({
    authenticateBearer: authenticateBearerMock,
    parseBearerToken: (header: string | null) =>
        header?.startsWith('Bearer gcw_') ? header.slice('Bearer '.length) : null,
}));

import { getActiveBookGuid, getActiveBookRootGuid, invalidateBookAccountGuidsCache } from '../book-scope';

const TOKEN_BOOK = 'b'.repeat(32);
const TOKEN_ROOT = 'r'.repeat(32);
const OTHER_BOOK = 'c'.repeat(32);
const OTHER_ROOT = 's'.repeat(32);

beforeEach(() => {
    vi.clearAllMocks();
    invalidateBookAccountGuidsCache();

    // No cookie session — exactly what a Bearer request looks like.
    getSessionMock.mockResolvedValue({ activeBookGuid: undefined, save: vi.fn() });

    // A different book sorts first in the database.
    findFirstMock.mockResolvedValue({ guid: OTHER_BOOK, root_account_guid: OTHER_ROOT });
    findUniqueMock.mockImplementation(async ({ where }: { where: { guid: string } }) =>
        where.guid === TOKEN_BOOK
            ? { root_account_guid: TOKEN_ROOT }
            : where.guid === OTHER_BOOK
                ? { root_account_guid: OTHER_ROOT }
                : null,
    );
});

function withAuthHeader(value: string | null) {
    headersMock.mockResolvedValue({ get: (name: string) => (name === 'authorization' ? value : null) });
}

describe('book scope for Bearer token requests', () => {
    it('resolves the token\'s book, not the first book in the database', async () => {
        withAuthHeader('Bearer gcw_livetoken');
        authenticateBearerMock.mockResolvedValue({ bookGuid: TOKEN_BOOK, role: 'readonly' });

        expect(await getActiveBookGuid()).toBe(TOKEN_BOOK);
        expect(await getActiveBookRootGuid()).toBe(TOKEN_ROOT);
        expect(findFirstMock).not.toHaveBeenCalled();
    });

    it('still falls back when the request carries no token', async () => {
        withAuthHeader(null);

        expect(await getActiveBookGuid()).toBe(OTHER_BOOK);
    });

    it('falls back when the token does not authenticate', async () => {
        withAuthHeader('Bearer gcw_revoked');
        authenticateBearerMock.mockResolvedValue(null);

        expect(await getActiveBookGuid()).toBe(OTHER_BOOK);
    });

    it('survives being called outside a request scope', async () => {
        // headers() throws during build and in the worker process.
        headersMock.mockRejectedValue(new Error('called outside a request scope'));

        expect(await getActiveBookGuid()).toBe(OTHER_BOOK);
    });
});
