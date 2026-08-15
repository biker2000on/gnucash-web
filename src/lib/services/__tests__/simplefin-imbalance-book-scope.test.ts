import { beforeEach, describe, expect, it, vi } from 'vitest';

const BOOK = 'b'.repeat(32);
const ROOT = 'r'.repeat(32);
const LOCAL_IMBALANCE = 'l'.repeat(32);
const FOREIGN_IMBALANCE = 'f'.repeat(32);

const mocks = vi.hoisted(() => ({
  prisma: {} as Record<string, unknown>,
  acquireNamedXactLock: vi.fn(),
  accountNameLockKey: vi.fn((parent: string, name: string) => `account:${parent}:${name}`),
  // Unused by the Imbalance path, but the service imports it: a mock missing a
  // real export fails as `undefined is not a function` the day this file grows
  // a case that reaches the symbol-commodity path.
  commodityLockKey: vi.fn((namespace: string, mnemonic: string) => `commodity:${namespace}:${mnemonic}`),
  guid: 0,
}));

vi.mock('@/lib/prisma', () => ({
  default: mocks.prisma,
  generateGuid: () => `new-${++mocks.guid}`.padEnd(32, '0'),
}));

vi.mock('@/lib/book-lock', () => ({
  acquireNamedXactLock: mocks.acquireNamedXactLock,
  accountNameLockKey: mocks.accountNameLockKey,
  commodityLockKey: mocks.commodityLockKey,
}));

import { getOrCreateImbalanceAccount } from '../simplefin-sync.service';

type Account = { guid: string; name: string; parent_guid: string };

function matchesWhere(account: Account, where: {
  name?: string;
  guid?: { in?: string[] };
  OR?: Array<{ guid?: { in?: string[] }; parent_guid?: string }>;
}): boolean {
  return (!where.name || account.name === where.name)
    && (!where.guid?.in || where.guid.in.includes(account.guid))
    && (!where.OR || where.OR.some(clause =>
      (!clause.guid?.in || clause.guid.in.includes(account.guid))
      && (!clause.parent_guid || clause.parent_guid === account.parent_guid)));
}

function installFake(rows: Account[]) {
  // This deliberately honours `where.guid.in`. A canned findFirst mock would
  // return FOREIGN_IMBALANCE even after the production filter was added and
  // would make this regression test worthless.
  let namedLockHeld = false;
  const namedLockWaiters: Array<() => void> = [];

  mocks.acquireNamedXactLock.mockImplementation(async (tx: { releaseNamedLock?: () => void }) => {
    if (namedLockHeld) await new Promise<void>(resolve => namedLockWaiters.push(resolve));
    namedLockHeld = true;
    tx.releaseNamedLock = () => {
      const next = namedLockWaiters.shift();
      if (next) next();
      else namedLockHeld = false;
    };
  });

  const accounts = {
    findFirst: vi.fn(async ({ where }: { where: { name?: string; guid?: { in?: string[] }; OR?: Array<{ guid?: { in?: string[] }; parent_guid?: string }> } }) =>
      rows.find(row => matchesWhere(row, where)) ?? null),
    create: vi.fn(async ({ data }: { data: Account }) => {
      rows.push({ guid: data.guid, name: data.name, parent_guid: data.parent_guid });
      return data;
    }),
  };

  Object.assign(mocks.prisma, {
    accounts,
    books: { findUnique: vi.fn(async () => ({ root_account_guid: ROOT })) },
    commodities: { findFirst: vi.fn(async () => ({ guid: 'c'.repeat(32) })) },
    $transaction: async (operation: (tx: { accounts: typeof accounts; releaseNamedLock?: () => void }) => Promise<string>) => {
      const tx: { accounts: typeof accounts; releaseNamedLock?: () => void } = { accounts };
      try {
        return await operation(tx);
      } finally {
        tx.releaseNamedLock?.();
      }
    },
  });
  return { rows, accounts };
}

describe('SimpleFin Imbalance account book scope and creation race', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guid = 0;
    for (const key of Object.keys(mocks.prisma)) delete mocks.prisma[key];
  });

  it('does not resolve another book\'s same-named Imbalance account', async () => {
    const { accounts } = installFake([
      { guid: FOREIGN_IMBALANCE, name: 'Imbalance-USD', parent_guid: 'x'.repeat(32) },
      { guid: LOCAL_IMBALANCE, name: 'Imbalance-USD', parent_guid: ROOT },
    ]);

    await expect(getOrCreateImbalanceAccount('USD', BOOK, new Set([ROOT, LOCAL_IMBALANCE])))
      .resolves.toBe(LOCAL_IMBALANCE);
    expect(accounts.create).not.toHaveBeenCalled();
    expect(accounts.findFirst).toHaveBeenCalledWith({
      where: {
        name: 'Imbalance-USD',
        OR: [
          { guid: { in: [ROOT, LOCAL_IMBALANCE] } },
          { parent_guid: ROOT },
        ],
      },
      select: { guid: true },
    });
  });

  it('serializes concurrent missing-account creation and returns one local account', async () => {
    const { rows, accounts } = installFake([]);
    const scope = new Set([ROOT]);

    const [first, second] = await Promise.all([
      getOrCreateImbalanceAccount('USD', BOOK, scope),
      getOrCreateImbalanceAccount('USD', BOOK, scope),
    ]);

    expect(first).toBe(second);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Imbalance-USD', parent_guid: ROOT });
    expect(accounts.create).toHaveBeenCalledTimes(1);
    expect(mocks.acquireNamedXactLock).toHaveBeenCalledTimes(2);
    expect(mocks.accountNameLockKey).toHaveBeenCalledWith(ROOT, 'Imbalance-USD');
  });
});
