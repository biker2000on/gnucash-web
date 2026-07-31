import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const ACTIVE_BOOK = 'a'.repeat(32);
const TARGET_BOOK = 'b'.repeat(32);

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireRole: vi.fn(),
  hasMinimumRole: vi.fn(),
  bookFindUnique: vi.fn(),
  bookUpdate: vi.fn(),
  accountFindUnique: vi.fn(),
  accountUpdate: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: mocks.requireAuth,
  requireRole: mocks.requireRole,
}));
vi.mock('@/lib/services/permission.service', () => ({
  getUserRoleForBook: vi.fn(),
  hasMinimumRole: mocks.hasMinimumRole,
  roleAtLeast: (role: string, minimum: string) => role === 'admin' || minimum === 'readonly',
}));
vi.mock('@/lib/prisma', () => ({
  default: {
    books: {
      findUnique: mocks.bookFindUnique,
      update: mocks.bookUpdate,
    },
    accounts: {
      findUnique: mocks.accountFindUnique,
      update: mocks.accountUpdate,
    },
    $queryRaw: mocks.queryRaw,
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/services/book-cleanup.service', () => ({
  collectBookStorageKeys: vi.fn(),
  deleteBookExtensionRows: vi.fn(),
  deleteStoredFileKeys: vi.fn(),
}));
vi.mock('@/lib/book-lock', () => ({ acquireBookLock: vi.fn() }));
vi.mock('@/lib/cache', () => ({ cacheInvalidateAllForBook: vi.fn() }));
vi.mock('@/lib/data-events', () => ({ publishDataChange: vi.fn() }));
vi.mock('@/lib/budget-ownership', () => ({ deleteOwnedBudgetsForBook: vi.fn() }));

import { GET, PUT, DELETE } from '../route';

const params = { params: Promise.resolve({ guid: TARGET_BOOK }) };
const getRequest = {
  nextUrl: new URL(`http://localhost/api/books/${TARGET_BOOK}`),
} as NextRequest;
const putRequest = {
  json: vi.fn(async () => ({ name: 'Renamed' })),
} as unknown as NextRequest;
const deleteRequest = {} as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ user: { id: 7, username: 'user' }, session: {} });
  mocks.requireRole.mockResolvedValue({
    user: { id: 7, username: 'admin' },
    role: 'admin',
    bookGuid: ACTIVE_BOOK,
  });
  mocks.hasMinimumRole.mockResolvedValue(false);
});

describe('/api/books/[guid] exact-target authorization', () => {
  it('blocks unauthorized metadata reads before querying the book', async () => {
    const response = await GET(getRequest, params);
    expect(response.status).toBe(403);
    expect(mocks.bookFindUnique).not.toHaveBeenCalled();
  });

  it('allows readonly access to the exact target', async () => {
    mocks.hasMinimumRole.mockResolvedValue(true);
    mocks.bookFindUnique.mockResolvedValue({
      guid: TARGET_BOOK,
      name: 'Target',
      description: null,
      root_account_guid: 'root',
      root_template_guid: 'template',
    });
    mocks.accountFindUnique.mockResolvedValue({ name: 'Root' });
    mocks.queryRaw.mockResolvedValue([{ count: 0n }]);

    const response = await GET(getRequest, params);
    expect(response.status).toBe(200);
    expect(mocks.hasMinimumRole).toHaveBeenCalledWith(7, TARGET_BOOK, 'readonly');
  });

  it('blocks active-book admins from updating a target they do not administer', async () => {
    const response = await PUT(putRequest, params);
    expect(response.status).toBe(403);
    expect(mocks.bookFindUnique).not.toHaveBeenCalled();
    expect(mocks.bookUpdate).not.toHaveBeenCalled();
  });

  it('allows an admin of the exact target to update it', async () => {
    mocks.hasMinimumRole.mockResolvedValue(true);
    mocks.bookFindUnique.mockResolvedValue({
      guid: TARGET_BOOK,
      root_account_guid: 'root',
    });
    mocks.bookUpdate.mockResolvedValue({});
    mocks.accountUpdate.mockResolvedValue({});

    const response = await PUT(putRequest, params);
    expect(response.status).toBe(200);
    expect(mocks.bookUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { guid: TARGET_BOOK },
    }));
  });

  it('blocks unauthorized and cross-book token deletes before any read/write', async () => {
    let response = await DELETE(deleteRequest, params);
    expect(response.status).toBe(403);
    expect(mocks.bookFindUnique).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();

    mocks.requireRole.mockResolvedValue({
      user: { id: 7, username: 'admin' },
      role: 'admin',
      bookGuid: ACTIVE_BOOK,
      viaToken: true,
    });
    mocks.hasMinimumRole.mockResolvedValue(true);
    response = await DELETE(deleteRequest, params);
    expect(response.status).toBe(403);
    expect(mocks.bookFindUnique).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('lets an exact-target admin proceed to the delete existence check', async () => {
    mocks.hasMinimumRole.mockResolvedValue(true);
    mocks.bookFindUnique.mockResolvedValue(null);

    const response = await DELETE(deleteRequest, params);
    expect(response.status).toBe(404);
    expect(mocks.bookFindUnique).toHaveBeenCalledWith({ where: { guid: TARGET_BOOK } });
  });
});
