import { beforeEach, describe, expect, it, vi } from 'vitest';

const BOOK = 'b'.repeat(32);
const IN_BOOK = 'a'.repeat(32);
const OUT_OF_BOOK = 'z'.repeat(32);

const mocks = vi.hoisted(() => ({
  prisma: {} as Record<string, unknown>,
  getAccountGuidsForBook: vi.fn(),
  decryptAccessUrl: vi.fn(),
  ensureNotificationsTable: vi.fn(),
  createNotification: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: mocks.prisma, generateGuid: vi.fn() }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: mocks.getAccountGuidsForBook }));
vi.mock('../simplefin.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../simplefin.service')>()),
  decryptAccessUrl: mocks.decryptAccessUrl,
}));
vi.mock('@/lib/notifications', () => ({
  ensureNotificationsTable: mocks.ensureNotificationsTable,
  createNotification: mocks.createNotification,
}));

import { runSimpleFinSync } from '../simplefin-sync.service';

describe('SimpleFin terminal status after book-scope mapping rejection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccountGuidsForBook.mockResolvedValue([IN_BOOK]);
    mocks.decryptAccessUrl.mockReturnValue('https://bridge.example/access');
    mocks.ensureNotificationsTable.mockResolvedValue(undefined);
    mocks.queryRaw.mockResolvedValue([]);
    mocks.executeRaw.mockResolvedValue(1);
    Object.assign(mocks.prisma, {
      gnucash_web_simplefin_connections: {
        findFirst: vi.fn(async () => ({
          id: 7,
          user_id: 42,
          access_url_encrypted: 'ciphertext',
          last_sync_at: null,
        })),
      },
      gnucash_web_simplefin_account_map: {
        findMany: vi.fn(async () => [{
          id: 11,
          simplefin_account_id: 'sf-checking',
          simplefin_account_name: 'Checking',
          gnucash_account_guid: OUT_OF_BOOK,
          last_sync_at: null,
          is_investment: false,
        }]),
      },
      $executeRaw: mocks.executeRaw,
      $queryRaw: mocks.queryRaw,
    });
  });

  it('fails and notifies instead of silently succeeding when every mapping is out of book', async () => {
    const result = await runSimpleFinSync(7, BOOK, { source: 'scheduled' });

    expect(result.status).toBe('failed');
    expect(result.errors).toEqual([{
      account: 'Checking',
      error: 'Mapped GnuCash account not found in this book',
    }]);
    expect(mocks.executeRaw).toHaveBeenCalledWith(
      expect.any(Array),
      'failed',
      'Checking: Mapped GnuCash account not found in this book',
      expect.any(Date),
      7,
    );
    expect(mocks.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 42,
      bookGuid: BOOK,
      severity: 'warning',
      type: 'simplefin_sync',
    }));
  });
});
