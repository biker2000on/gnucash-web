/**
 * Reconciled/frozen policy on the lot engine's REVERT paths
 * (clearLotAssignments, revertScrubRun).
 *
 * The policy is deliberately asymmetric — see assertRevertPreservesReconciled
 * in lot-assignment.ts:
 *
 *   - deleting a wholly generated gains transaction is GUARDED (nothing
 *     restores that amount, so a reconciled posting would just vanish);
 *   - restoring a split the run modified in place with no compensating
 *     sub-split is GUARDED (the valueZeroValueTrade case: FMV back to $0);
 *   - deleting the run's sub-splits while restoring their parent in the same
 *     transaction is EXEMPT (net-zero repartition; the sub-splits only ever
 *     INHERITED the parent's reconcile state).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, tryAcquireBookLockMock } = vi.hoisted(() => ({
  prismaMock: {
    splits: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    slots: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), deleteMany: vi.fn() },
    lots: { findMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
    transactions: { findMany: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
  tryAcquireBookLockMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/book-lock', () => {
  class BookBusyError extends Error {}
  return {
    BookBusyError,
    bookLockKey: vi.fn(() => 'k'),
    tryAcquireBookLock: tryAcquireBookLockMock,
  };
});
vi.mock('@/lib/db', () => ({ tryWithDatabaseAdvisoryLock: vi.fn() }));

import { clearLotAssignments, revertScrubRun } from '../lot-assignment';
import { ReconciledSplitError } from '../services/reconciled-split.service';

const ACCOUNT = 'acct'.padEnd(32, '0');
const RUN_ID = 'run-001';
const SELL_TX = 'selltx'.padEnd(32, '0');
const GAINS_TX = 'gainstx'.padEnd(32, '0');
const ORIGINAL_SPLIT = 'origsplit'.padEnd(32, '0');
const SUB_SPLIT = 'subsplit'.padEnd(32, '0');
const GAINS_SPLIT = 'gainsplit'.padEnd(32, '0');

function slot(objGuid: string, name: string, val: string) {
  return { obj_guid: objGuid, name, string_val: val };
}

beforeEach(() => {
  vi.clearAllMocks();
  tryAcquireBookLockMock.mockResolvedValue(true);
  prismaMock.$transaction.mockImplementation(
    async (cb: (tx: unknown) => unknown) => cb(prismaMock),
  );
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.$executeRaw.mockResolvedValue(0);
  prismaMock.splits.update.mockResolvedValue({});
  prismaMock.splits.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.splits.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.slots.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.slots.count.mockResolvedValue(0);
  prismaMock.slots.findFirst.mockResolvedValue(null);
  prismaMock.lots.findMany.mockResolvedValue([]);
  prismaMock.lots.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.lots.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.transactions.findMany.mockResolvedValue([]);
  prismaMock.transactions.deleteMany.mockResolvedValue({ count: 0 });
});

// ---------------------------------------------------------------------------
// revertScrubRun
// ---------------------------------------------------------------------------

describe('revertScrubRun reconciled policy', () => {
  /**
   * Wire a run that produced BOTH shapes:
   *  - a sell split carved into (ORIGINAL_SPLIT restored + SUB_SPLIT deleted)
   *    inside SELL_TX — the compensated, exempt case;
   *  - a wholly generated gains transaction GAINS_TX — the guarded case.
   * `include` selects which of the two the run is scoped to.
   */
  function wireRun(opts: {
    withGainsTx: boolean;
    withSubSplit: boolean;
    protectedRows: unknown[];
  }) {
    const taggedGuids = [ORIGINAL_SPLIT];
    if (opts.withSubSplit) taggedGuids.push(SUB_SPLIT);
    if (opts.withGainsTx) taggedGuids.push(GAINS_TX, GAINS_SPLIT);

    prismaMock.slots.findMany.mockImplementation(
      async (args: { where: { name?: string } }) => {
        if (args.where.name === 'gnucash_web_generated') {
          return taggedGuids.map(g => slot(g, 'gnucash_web_generated', RUN_ID));
        }
        if (args.where.name === 'original_quantity_num') {
          return [slot(ORIGINAL_SPLIT, 'original_quantity_num', '-100')];
        }
        return [];
      },
    );
    prismaMock.transactions.findMany.mockResolvedValue(
      opts.withGainsTx ? [{ guid: GAINS_TX }] : [],
    );

    const taggedSplits = [
      { guid: ORIGINAL_SPLIT, account_guid: ACCOUNT, tx_guid: SELL_TX },
      ...(opts.withSubSplit
        ? [{ guid: SUB_SPLIT, account_guid: ACCOUNT, tx_guid: SELL_TX }]
        : []),
      ...(opts.withGainsTx
        ? [{ guid: GAINS_SPLIT, account_guid: ACCOUNT, tx_guid: GAINS_TX }]
        : []),
    ];

    prismaMock.splits.findMany.mockImplementation(
      async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
        // The policy's protected-row read (has the reconcile_state filter).
        if (args.where.reconcile_state) return opts.protectedRows;
        // The policy's tagged-split lookup (guid + tx_guid only).
        if (args.select && 'tx_guid' in args.select && !('account_guid' in args.select)) {
          return taggedSplits.map(s => ({ guid: s.guid, tx_guid: s.tx_guid }));
        }
        // Parents of a generated transaction being deleted.
        if (args.where.tx_guid) return [{ guid: GAINS_SPLIT, account_guid: ACCOUNT }];
        return taggedSplits;
      },
    );
  }

  it.each([
    ['reconciled', 'y'],
    ['frozen', 'f'],
  ])('refuses to delete a generated gains transaction with a %s split', async (_label, state) => {
    wireRun({
      withGainsTx: true,
      withSubSplit: true,
      protectedRows: [{
        guid: GAINS_SPLIT, tx_guid: GAINS_TX, account_guid: ACCOUNT,
        reconcile_state: state, account: { name: 'Assets:Brokerage' },
      }],
    });

    await expect(revertScrubRun(RUN_ID)).rejects.toBeInstanceOf(ReconciledSplitError);
    // Nothing destroyed — the policy runs before the first delete.
    expect(prismaMock.splits.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.transactions.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.splits.update).not.toHaveBeenCalled();
  });

  it.each([
    ['reconciled', 'y'],
    ['frozen', 'f'],
  ])('refuses an UNCOMPENSATED in-place restore of a %s split', async (_label, state) => {
    // No sub-split in the same transaction → the restore is not paired with a
    // compensating deletion (this is the valueZeroValueTrade shape).
    wireRun({
      withGainsTx: false,
      withSubSplit: false,
      protectedRows: [{
        guid: ORIGINAL_SPLIT, tx_guid: SELL_TX, account_guid: ACCOUNT,
        reconcile_state: state, account: { name: 'Assets:Brokerage' },
      }],
    });

    await expect(revertScrubRun(RUN_ID)).rejects.toBeInstanceOf(ReconciledSplitError);
    expect(prismaMock.splits.update).not.toHaveBeenCalled();
  });

  it.each([
    ['reconciled', 'y'],
    ['frozen', 'f'],
  ])('ALLOWS a compensated restore whose sub-splits merely inherited %s', async (_label, state) => {
    // ORIGINAL_SPLIT is restored while SUB_SPLIT (same transaction, same run)
    // is deleted: the two halves sum back to the pre-scrub original, so the
    // account's reconciled total is unchanged. This is the deliberate
    // exemption.
    wireRun({
      withGainsTx: false,
      withSubSplit: true,
      protectedRows: [
        {
          guid: ORIGINAL_SPLIT, tx_guid: SELL_TX, account_guid: ACCOUNT,
          reconcile_state: state, account: { name: 'Assets:Brokerage' },
        },
        {
          guid: SUB_SPLIT, tx_guid: SELL_TX, account_guid: ACCOUNT,
          reconcile_state: state, account: { name: 'Assets:Brokerage' },
        },
      ],
    });
    prismaMock.slots.findFirst.mockResolvedValue({ string_val: '100' });

    await expect(revertScrubRun(RUN_ID)).resolves.toMatchObject({ reverted: expect.any(Number) });
    expect(prismaMock.splits.update).toHaveBeenCalled();
  });

  it('reverts normally when nothing is reconciled', async () => {
    wireRun({ withGainsTx: true, withSubSplit: true, protectedRows: [] });
    prismaMock.slots.findFirst.mockResolvedValue({ string_val: '100' });

    await expect(revertScrubRun(RUN_ID)).resolves.toMatchObject({ reverted: expect.any(Number) });
    expect(prismaMock.transactions.deleteMany).toHaveBeenCalled();
  });

  it('locks every affected parent transaction FOR UPDATE before the policy read', async () => {
    wireRun({ withGainsTx: true, withSubSplit: true, protectedRows: [] });
    prismaMock.slots.findFirst.mockResolvedValue({ string_val: '100' });

    await revertScrubRun(RUN_ID);

    const lockCalls = prismaMock.$queryRaw.mock.calls.filter(
      (call: unknown[]) => (call[0] as TemplateStringsArray).join('?').includes('FOR UPDATE'),
    );
    expect(lockCalls.length).toBeGreaterThan(0);
    const sql = (lockCalls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toContain('FROM transactions');
    expect(sql).toContain('ORDER BY guid');
    // Both the generated transaction and the sell transaction are held.
    expect(lockCalls[0][1]).toEqual([GAINS_TX, SELL_TX].sort());
    // Lock precedes every write.
    expect(lockCalls[0] && prismaMock.$queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(prismaMock.splits.deleteMany.mock.invocationCallOrder[0]);
  });
});

// ---------------------------------------------------------------------------
// clearLotAssignments
// ---------------------------------------------------------------------------

describe('clearLotAssignments reconciled policy', () => {
  function wireClear(protectedRows: unknown[]) {
    prismaMock.slots.findMany.mockImplementation(
      async (args: { where: { name?: string } }) => {
        if (args.where.name === 'gnucash_web_generated') {
          return [slot(GAINS_SPLIT, 'gnucash_web_generated', RUN_ID)];
        }
        if (args.where.name === 'original_quantity_num') {
          return [slot(ORIGINAL_SPLIT, 'original_quantity_num', '-100')];
        }
        return [];
      },
    );
    // Every split in GAINS_TX is tagged → it is a generated gains transaction.
    prismaMock.slots.count.mockResolvedValue(1);
    prismaMock.splits.findMany.mockImplementation(
      async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
        if (args.where.reconcile_state) return protectedRows;
        if (args.where.account_guid) {
          return [{ guid: ORIGINAL_SPLIT }, { guid: GAINS_SPLIT }];
        }
        if (args.where.tx_guid) return [{ guid: GAINS_SPLIT }];
        // guid-in lookup (tagged splits)
        return [{ guid: GAINS_SPLIT, tx_guid: GAINS_TX }];
      },
    );
  }

  it.each([
    ['reconciled', 'y'],
    ['frozen', 'f'],
  ])('refuses when a generated gains split is %s, before any write', async (_label, state) => {
    wireClear([{
      guid: GAINS_SPLIT, tx_guid: GAINS_TX, account_guid: ACCOUNT,
      reconcile_state: state, account: { name: 'Assets:Brokerage' },
    }]);

    await expect(clearLotAssignments(ACCOUNT)).rejects.toBeInstanceOf(ReconciledSplitError);
    expect(prismaMock.splits.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.splits.update).not.toHaveBeenCalled();
    expect(prismaMock.transactions.deleteMany).not.toHaveBeenCalled();
  });

  it('clears normally when nothing is reconciled', async () => {
    wireClear([]);
    prismaMock.slots.findFirst.mockResolvedValue({ string_val: '100' });

    await expect(clearLotAssignments(ACCOUNT)).resolves.toMatchObject({
      splitsUnassigned: expect.any(Number),
    });
    expect(prismaMock.transactions.deleteMany).toHaveBeenCalled();
  });

  it('locks the account\'s transactions FOR UPDATE before reading anything', async () => {
    wireClear([]);
    prismaMock.slots.findFirst.mockResolvedValue({ string_val: '100' });

    await clearLotAssignments(ACCOUNT);

    const sql = (prismaMock.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toContain('FROM transactions');
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('ORDER BY guid');
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(prismaMock.splits.findMany.mock.invocationCallOrder[0]);
  });
});
