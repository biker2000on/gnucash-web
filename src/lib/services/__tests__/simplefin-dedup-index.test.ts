/**
 * ASI-6-004 — the SimpleFin dedup index is loaded once per run, not once per
 * mapped account.
 *
 * The old code issued an unfiltered `gnucash_web_transaction_meta.findMany`
 * inside the per-mapped-account loop: N mapped accounts meant N full scans of
 * a table that grows without bound. These tests pin both halves of the fix —
 * the query count, and that dedup decisions are unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const BOOK = 'b'.repeat(32);
const ACCT = (n: number) => String(n).repeat(32).slice(0, 32);

const mocks = vi.hoisted(() => ({
  prisma: {} as Record<string, unknown>,
  getAccountGuidsForBook: vi.fn(),
  decryptAccessUrl: vi.fn(),
  fetchAccountsChunked: vi.fn(),
  ensureNotificationsTable: vi.fn(),
  createNotification: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
  getCachedLockDate: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: mocks.prisma, generateGuid: vi.fn() }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: mocks.getAccountGuidsForBook }));
vi.mock('../simplefin.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../simplefin.service')>()),
  decryptAccessUrl: mocks.decryptAccessUrl,
  fetchAccountsChunked: mocks.fetchAccountsChunked,
}));
vi.mock('@/lib/notifications', () => ({
  ensureNotificationsTable: mocks.ensureNotificationsTable,
  createNotification: mocks.createNotification,
}));
vi.mock('@/lib/services/period-lock.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/period-lock.service')>()),
  getCachedLockDate: mocks.getCachedLockDate,
}));

import {
  SIMPLEFIN_DEDUP_ID_CHUNK,
  collectFeedTransactionIds,
  loadExistingSimpleFinIds,
  runSimpleFinSync,
} from '../simplefin-sync.service';

describe('loadExistingSimpleFinIds', () => {
  it('issues a single query for a normal-sized candidate list', async () => {
    const findMany = vi.fn(async () => [
      { simplefin_transaction_id: 'sf-1', simplefin_transaction_id_2: null },
    ]);

    const ids = await loadExistingSimpleFinIds(['sf-1', 'sf-2', 'sf-3'], findMany);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(['sf-1', 'sf-2', 'sf-3']);
    expect([...ids]).toEqual(['sf-1']);
  });

  it('issues no query at all when there is nothing to dedup against', async () => {
    const findMany = vi.fn(async () => []);
    expect([...(await loadExistingSimpleFinIds([], findMany))]).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('collects both id columns so a two-legged transfer dedups on either leg', async () => {
    const findMany = vi.fn(async () => [
      { simplefin_transaction_id: 'sf-a', simplefin_transaction_id_2: 'sf-b' },
    ]);
    const ids = await loadExistingSimpleFinIds(['sf-a', 'sf-b'], findMany);
    expect(ids.has('sf-a')).toBe(true);
    expect(ids.has('sf-b')).toBe(true);
  });

  it('chunks a candidate list larger than the bind-parameter budget', async () => {
    const candidates = Array.from({ length: SIMPLEFIN_DEDUP_ID_CHUNK + 1 }, (_, i) => `sf-${i}`);
    const findMany = vi.fn(async (chunk: string[]) => chunk.slice(0, 1).map(id => ({
      simplefin_transaction_id: id,
      simplefin_transaction_id_2: null,
    })));

    const ids = await loadExistingSimpleFinIds(candidates, findMany);

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[0][0]).toHaveLength(SIMPLEFIN_DEDUP_ID_CHUNK);
    expect(findMany.mock.calls[1][0]).toEqual([`sf-${SIMPLEFIN_DEDUP_ID_CHUNK}`]);
    expect(ids.has('sf-0')).toBe(true);
    expect(ids.has(`sf-${SIMPLEFIN_DEDUP_ID_CHUNK}`)).toBe(true);
  });
});

describe('collectFeedTransactionIds', () => {
  it('gathers ids from mapped accounts only, deduplicated', () => {
    const sfAccountMap = new Map<string, { transactions?: Array<{ id: string }> }>([
      ['sf-1', { transactions: [{ id: 'a' }, { id: 'b' }] }],
      ['sf-2', { transactions: [{ id: 'b' }, { id: 'c' }] }],
      ['sf-unmapped', { transactions: [{ id: 'z' }] }],
      ['sf-3', {}],
    ]);

    const ids = collectFeedTransactionIds(
      [
        { simplefin_account_id: 'sf-1' },
        { simplefin_account_id: 'sf-2' },
        { simplefin_account_id: 'sf-3' },
        { simplefin_account_id: 'sf-missing-from-feed' },
      ],
      sfAccountMap,
    );

    expect(ids.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('runSimpleFinSync dedup index across N mapped accounts', () => {
  const MAPPED = 3;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mocks.prisma)) delete mocks.prisma[key];

    mocks.getAccountGuidsForBook.mockResolvedValue(
      Array.from({ length: MAPPED }, (_, i) => ACCT(i + 1)),
    );
    mocks.decryptAccessUrl.mockReturnValue('https://bridge.example/access');
    mocks.ensureNotificationsTable.mockResolvedValue(undefined);
    mocks.createNotification.mockResolvedValue(undefined);
    mocks.queryRaw.mockResolvedValue([]);
    mocks.executeRaw.mockResolvedValue(1);
    mocks.getCachedLockDate.mockResolvedValue(null);

    // Each mapped account contributes two already-imported feed rows.
    mocks.fetchAccountsChunked.mockResolvedValue({
      errors: [],
      accounts: Array.from({ length: MAPPED }, (_, i) => ({
        id: `sf-${i + 1}`,
        name: `Account ${i + 1}`,
        currency: 'USD',
        balance: '100.00',
        transactions: [
          { id: `sf-${i + 1}-txn-a`, posted: 1750000000, amount: '-10.00', description: 'Known A' },
          { id: `sf-${i + 1}-txn-b`, posted: 1750086400, amount: '-20.00', description: 'Known B' },
        ],
      })),
    });
  });

  function installPrisma(metaFindMany: ReturnType<typeof vi.fn>) {
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
        findMany: vi.fn(async () => Array.from({ length: MAPPED }, (_, i) => ({
          id: i + 1,
          simplefin_account_id: `sf-${i + 1}`,
          simplefin_account_name: `Account ${i + 1}`,
          gnucash_account_guid: ACCT(i + 1),
          last_sync_at: null,
          is_investment: false,
        }))),
        update: vi.fn(async () => ({})),
      },
      gnucash_web_transaction_meta: { findMany: metaFindMany },
      accounts: {
        findFirst: vi.fn(async ({ where }: { where: { guid: { equals: string } } }) => ({
          guid: where.guid.equals,
          commodity_guid: 'c'.repeat(32),
          commodity_scu: 100,
          commodity: { mnemonic: 'USD' },
        })),
      },
      $executeRaw: mocks.executeRaw,
      $queryRaw: mocks.queryRaw,
    });
  }

  it('queries transaction_meta exactly once, not once per mapped account', async () => {
    const metaFindMany = vi.fn(async () => [
      { simplefin_transaction_id: 'sf-1-txn-a', simplefin_transaction_id_2: null },
      { simplefin_transaction_id: 'sf-1-txn-b', simplefin_transaction_id_2: null },
      { simplefin_transaction_id: 'sf-2-txn-a', simplefin_transaction_id_2: 'sf-2-txn-b' },
      { simplefin_transaction_id: 'sf-3-txn-a', simplefin_transaction_id_2: null },
      { simplefin_transaction_id: 'sf-3-txn-b', simplefin_transaction_id_2: null },
    ]);
    installPrisma(metaFindMany);

    const result = await runSimpleFinSync(7, BOOK, { source: 'scheduled' });

    // The whole point of the fix: one query for three mapped accounts.
    expect(metaFindMany).toHaveBeenCalledTimes(1);
    // …and it is filtered to the feed rows this run could collide with.
    const [findManyArgs] = metaFindMany.mock.calls[0] as unknown as [{
      where: { OR: Array<Record<string, { in: string[] }>> };
    }];
    const where = findManyArgs.where;
    expect(where.OR[0].simplefin_transaction_id.in).toHaveLength(MAPPED * 2);

    // Dedup semantics unchanged: every row was already imported, so every row
    // is skipped and nothing is imported.
    expect(result.accountsProcessed).toBe(MAPPED);
    expect(result.transactionsSkipped).toBe(MAPPED * 2);
    expect(result.transactionsImported).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
