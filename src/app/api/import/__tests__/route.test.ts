import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const ACTIVE_BOOK = 'a'.repeat(32);
const TARGET_BOOK = 'b'.repeat(32);

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  parse: vi.fn(),
  importData: vi.fn(),
  grantRole: vi.fn(),
  hasMinimumRole: vi.fn(),
  targetFindUnique: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole: mocks.requireRole }));
vi.mock('@/lib/gnucash-xml/parser', () => ({ parseGnuCashXml: mocks.parse }));
vi.mock('@/lib/gnucash-xml/importer', () => ({
  BookAlreadyExistsError: class BookAlreadyExistsError extends Error {},
  importGnuCashData: mocks.importData,
}));
vi.mock('@/lib/services/permission.service', () => ({
  grantRole: mocks.grantRole,
  hasMinimumRole: mocks.hasMinimumRole,
  roleAtLeast: (role: string, minimum: string) => role === 'admin' && minimum === 'admin',
}));
vi.mock('@/lib/prisma', () => ({
  default: { books: { findUnique: mocks.targetFindUnique } },
}));
vi.mock('@/lib/cache', () => ({ cacheInvalidateFrom: vi.fn() }));
vi.mock('@/lib/data-events', () => ({ publishDataChange: vi.fn() }));

import { POST } from '../route';

function request(options: { overwrite?: boolean; stream?: boolean } = {}): NextRequest {
  const values = new Map<string, unknown>([
    ['file', {
      name: 'target.gnucash',
      size: 10,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    }],
    ['overwrite', options.overwrite ? 'true' : 'false'],
    ['stream', options.stream ? 'true' : 'false'],
  ]);
  return {
    formData: vi.fn(async () => ({ get: (key: string) => values.get(key) ?? null })),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({
    user: { id: 7, username: 'admin' },
    role: 'admin',
    bookGuid: ACTIVE_BOOK,
  });
  mocks.parse.mockReturnValue({
    book: { id: TARGET_BOOK },
    commodities: [],
    accounts: [],
    transactions: [],
    pricedb: [],
    budgets: [],
  });
  mocks.targetFindUnique.mockResolvedValue({ guid: TARGET_BOOK });
  mocks.importData.mockResolvedValue({ bookGuid: TARGET_BOOK });
  mocks.hasMinimumRole.mockResolvedValue(false);
});

describe('POST /api/import target-book authorization', () => {
  it.each([false, true])(
    'rejects an unauthorized existing target before the %s streaming path',
    async (stream) => {
      const response = await POST(request({ overwrite: true, stream }));

      expect(response.status).toBe(403);
      expect(mocks.importData).not.toHaveBeenCalled();
      expect(mocks.grantRole).not.toHaveBeenCalled();
    },
  );

  it('allows a session admin of another exact target without re-granting access', async () => {
    mocks.hasMinimumRole.mockResolvedValue(true);

    const response = await POST(request({ overwrite: true }));

    expect(response.status).toBe(200);
    expect(mocks.hasMinimumRole).toHaveBeenCalledWith(7, TARGET_BOOK, 'admin');
    expect(mocks.importData).toHaveBeenCalledWith(
      expect.anything(),
      'target',
      { overwrite: true },
    );
    expect(mocks.grantRole).not.toHaveBeenCalled();
  });

  it('pins bearer-token imports to the token book', async () => {
    mocks.requireRole.mockResolvedValue({
      user: { id: 7, username: 'admin' },
      role: 'admin',
      bookGuid: ACTIVE_BOOK,
      viaToken: true,
    });
    mocks.hasMinimumRole.mockResolvedValue(true);

    const response = await POST(request({ overwrite: true }));

    expect(response.status).toBe(403);
    expect(mocks.importData).not.toHaveBeenCalled();
  });

  it('allows an admin token to overwrite its exact target book', async () => {
    mocks.parse.mockReturnValue({
      book: { id: ACTIVE_BOOK },
      commodities: [],
      accounts: [],
      transactions: [],
      pricedb: [],
      budgets: [],
    });
    mocks.targetFindUnique.mockResolvedValue({ guid: ACTIVE_BOOK });
    mocks.importData.mockResolvedValue({ bookGuid: ACTIVE_BOOK });
    mocks.requireRole.mockResolvedValue({
      user: { id: 7, username: 'admin' },
      role: 'admin',
      bookGuid: ACTIVE_BOOK,
      viaToken: true,
    });

    const response = await POST(request({ overwrite: true }));

    expect(response.status).toBe(200);
    expect(mocks.importData).toHaveBeenCalled();
    expect(mocks.grantRole).not.toHaveBeenCalled();
  });

  it('grants access only when importing a genuinely new book', async () => {
    mocks.targetFindUnique.mockResolvedValue(null);

    const response = await POST(request({ overwrite: true }));

    expect(response.status).toBe(200);
    expect(mocks.importData).toHaveBeenCalledWith(
      expect.anything(),
      'target',
      { overwrite: false },
    );
    expect(mocks.grantRole).toHaveBeenCalledWith(7, TARGET_BOOK, 'admin', 7);
  });
});
