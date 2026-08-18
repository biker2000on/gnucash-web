/**
 * SCOPE OF THESE ORDERING TESTS (read before trusting them)
 *
 * They assert the ORDER in which statements are issued against a mocked
 * Prisma client: that the `FOR UPDATE` lock statement is emitted before the
 * reconcile-state read, and the read before the write. That is exactly the
 * regression that has now recurred twice, so it is worth pinning.
 *
 * They do NOT prove:
 *   - that PostgreSQL actually acquires or holds the row lock (a no-op
 *     $queryRaw would satisfy every assertion here);
 *   - that a concurrent reconcile really blocks on it;
 *   - rollback behaviour, or that the canonical guid ordering prevents a real
 *     deadlock.
 *
 * Proving those needs two real database transactions and a barrier. This repo
 * has no real-database test harness (no TEST_DATABASE_URL, no postgres service
 * in docker-compose.yml, no testcontainers, and every prisma-touching test
 * mocks the client), and building one is out of scope here — it is filed as a
 * separate follow-up.
 */
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
    slots: {
      findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(),
      deleteMany: vi.fn(), create: vi.fn(),
    },
    lots: { findMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    transactions: { findMany: vi.fn(), deleteMany: vi.fn() },
    accounts: { findUnique: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    // Provisioning DDL for the app-owned average-cost history table. This file
    // asserts lock ORDER over $queryRaw, so the history table is deliberately
    // left unbacked here rather than adding calls to that sequence; its
    // behaviour is covered by lot-assignment-average-cost.test.ts and the
    // real-PostgreSQL avg-basis-history.integration.test.ts.
    $executeRawUnsafe: vi.fn(),
  },
  tryAcquireBookLockMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/book-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/book-lock')>();
  return {
    ...actual,
    bookLockKey: vi.fn(() => 'k'),
    tryAcquireBookLock: tryAcquireBookLockMock,
  };
});
vi.mock('@/lib/db', () => ({ tryWithDatabaseAdvisoryLock: vi.fn() }));

import { autoAssignLots, clearLotAssignments, revertScrubRun } from '../lot-assignment';
import { ReconciledSplitError } from '../services/reconciled-split.service';
import { PARENT_SPLIT_SLOT } from '../lot-scrub';

const ACCOUNT = 'acct'.padEnd(32, '0');
const RUN_ID = 'run-001';
const SELL_TX = 'selltx'.padEnd(32, '0');
const GAINS_TX = 'gainstx'.padEnd(32, '0');
const ORIGINAL_SPLIT = 'origsplit'.padEnd(32, '0');
const SUB_SPLIT = 'subsplit'.padEnd(32, '0');
const GAINS_SPLIT = 'gainsplit'.padEnd(32, '0');
// valueZeroValueTrade rewrites and tags BOTH legs of one transaction.
const TRADE_TX = 'tradetx'.padEnd(32, '0');
const TRADE_LEG_A = 'tradelega'.padEnd(32, '0');
const TRADE_LEG_B = 'tradelegb'.padEnd(32, '0');
// One parent transaction holding BOTH a partitioned sale and the trade pair —
// the case a per-transaction compensation count gets wrong.
const MIXED_TX = 'mixedtx'.padEnd(32, '0');
const MIXED_SELL = 'mixedsell'.padEnd(32, '0');
const MIXED_SUB = 'mixedsub'.padEnd(32, '0');

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
  prismaMock.$executeRawUnsafe.mockResolvedValue(0);
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
  prismaMock.slots.create.mockResolvedValue({});
  prismaMock.lots.create.mockResolvedValue({});
  prismaMock.accounts.findUnique.mockResolvedValue({
    commodity_guid: 'cmdty'.padEnd(32, '0'),
    commodity_scu: 10000,
  });
});

// ---------------------------------------------------------------------------
// autoAssignLots — lock placement (M2)
// ---------------------------------------------------------------------------

describe('autoAssignLots lock placement', () => {
  const BUY_SPLIT = 'buysplit'.padEnd(32, '0');
  const BUY_TX = 'buytx'.padEnd(32, '0');

  /** One unassigned BUY split, which creates a lot and writes the split. */
  function wireOneBuy() {
    prismaMock.splits.findMany.mockImplementation(
      async (args: { where: Record<string, unknown> }) => {
        // Counter-leg lookup for classification: no counter → plain buy.
        if (args.where.tx_guid) return [];
        return [{
          guid: BUY_SPLIT,
          tx_guid: BUY_TX,
          account_guid: ACCOUNT,
          quantity_num: 100n,
          quantity_denom: 1n,
          value_num: 10000n,
          value_denom: 100n,
          lot_guid: null,
          transaction: { post_date: new Date('2026-01-02T00:00:00.000Z') },
        }];
      },
    );
  }

  it('locks the account transactions BEFORE the assign pass reads or writes', async () => {
    // The lock used to be taken only at bumpAccountTransactionTokens, AFTER
    // assign* had already read and rewritten splits: a concurrent reconcile
    // could commit 'y' into that window, and the opposite lock order was an
    // ABBA deadlock against the reconcile routes.
    //
    // NOTE (see the file header): this asserts call ORDER against mocks. It
    // pins the ordering regression; it does NOT prove PostgreSQL row-lock
    // behaviour or real deadlock avoidance.
    wireOneBuy();

    await autoAssignLots(ACCOUNT, 'fifo');

    const lockCalls = prismaMock.$queryRaw.mock.calls.filter(
      (call: unknown[]) => (call[0] as TemplateStringsArray).join('?').includes('FOR UPDATE'),
    );
    expect(lockCalls.length).toBeGreaterThan(0);
    const sql = (lockCalls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toContain('FROM transactions');
    expect(sql).toContain('ORDER BY guid');

    const lockOrder = prismaMock.$queryRaw.mock.invocationCallOrder[0];
    // ...before the assign pass READS the account's splits...
    expect(lockOrder).toBeLessThan(prismaMock.splits.findMany.mock.invocationCallOrder[0]);
    // ...and before it WRITES anything (lot creation, split assignment).
    expect(lockOrder).toBeLessThan(prismaMock.lots.create.mock.invocationCallOrder[0]);
    expect(lockOrder).toBeLessThan(prismaMock.splits.update.mock.invocationCallOrder[0]);
  });

  it('takes the lock even when the account has nothing to assign', async () => {
    prismaMock.splits.findMany.mockResolvedValue([]);

    await autoAssignLots(ACCOUNT, 'fifo');

    const lockCalls = prismaMock.$queryRaw.mock.calls.filter(
      (call: unknown[]) => (call[0] as TemplateStringsArray).join('?').includes('FOR UPDATE'),
    );
    expect(lockCalls.length).toBeGreaterThan(0);
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(prismaMock.splits.findMany.mock.invocationCallOrder[0]);
  });
});

// ---------------------------------------------------------------------------
// revertScrubRun
// ---------------------------------------------------------------------------

describe('revertScrubRun reconciled policy', () => {
  /**
   * Drive the policy from an explicit STRUCTURAL description of what the run
   * left behind, because that structure — not mere co-tagging — is what
   * separates a reversible partition from an in-place multi-leg rewrite.
   *
   *   tagged          every split carrying this run's gnucash_web_generated tag
   *   restored        splits carrying original_* slots (restored in place)
   *   generatedTxGuids  wholly generated transactions (deleted outright)
   *
   * A split that is tagged but NOT restored is a sub-split ROW the run
   * created and is now deleting — the only thing that can compensate a
   * restore.
   */
  function wireRun(spec: {
    tagged: { guid: string; tx: string }[];
    restored: string[];
    generatedTxGuids: string[];
    protectedRows: unknown[];
    /** sub-split guid -> the split it was carved out of (PARENT_SPLIT_SLOT). */
    parentOf?: Record<string, string>;
  }) {
    const taggedGuids = [...spec.tagged.map(t => t.guid), ...spec.generatedTxGuids];
    const parentOf = spec.parentOf ?? {};

    prismaMock.slots.findMany.mockImplementation(
      async (args: { where: { name?: string; obj_guid?: { in?: string[] } } }) => {
        if (args.where.name === 'gnucash_web_generated') {
          return taggedGuids.map(g => slot(g, 'gnucash_web_generated', RUN_ID));
        }
        if (args.where.name === 'original_quantity_num') {
          return spec.restored.map(g => slot(g, 'original_quantity_num', '-100'));
        }
        // Provenance: which parent each DELETED sub-split was carved out of.
        if (args.where.name === PARENT_SPLIT_SLOT) {
          const asked = args.where.obj_guid?.in ?? [];
          return asked
            .filter(g => parentOf[g])
            .map(g => slot(g, PARENT_SPLIT_SLOT, parentOf[g]));
        }
        return [];
      },
    );
    prismaMock.transactions.findMany.mockResolvedValue(
      spec.generatedTxGuids.map(guid => ({ guid })),
    );

    prismaMock.splits.findMany.mockImplementation(
      async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
        // The policy's protected-row read (has the reconcile_state filter).
        if (args.where.reconcile_state) return spec.protectedRows;
        // The policy's tagged-split lookup (guid + tx_guid only).
        if (args.select && 'tx_guid' in args.select && !('account_guid' in args.select)) {
          return spec.tagged.map(t => ({ guid: t.guid, tx_guid: t.tx }));
        }
        // Splits of a generated transaction being deleted.
        if (args.where.tx_guid) {
          return spec.tagged
            .filter(t => spec.generatedTxGuids.includes(t.tx))
            .map(t => ({ guid: t.guid, account_guid: ACCOUNT }));
        }
        return spec.tagged.map(t => ({
          guid: t.guid, account_guid: ACCOUNT, tx_guid: t.tx,
        }));
      },
    );
  }

  /** splitSellAcrossLots shape: parent restored, sub-split row deleted. */
  function partitionRun(protectedRows: unknown[]) {
    return {
      tagged: [
        { guid: ORIGINAL_SPLIT, tx: SELL_TX },
        { guid: SUB_SPLIT, tx: SELL_TX },
      ],
      restored: [ORIGINAL_SPLIT],
      generatedTxGuids: [],
      protectedRows,
      // SUB_SPLIT was carved out of ORIGINAL_SPLIT — that specific link is
      // what makes the restore compensated.
      parentOf: { [SUB_SPLIT]: ORIGINAL_SPLIT },
    };
  }

  /** valueZeroValueTrade shape: BOTH legs tagged AND both restored in place. */
  function zeroValueTradeRun(protectedRows: unknown[]) {
    return {
      tagged: [
        { guid: TRADE_LEG_A, tx: TRADE_TX },
        { guid: TRADE_LEG_B, tx: TRADE_TX },
      ],
      restored: [TRADE_LEG_A, TRADE_LEG_B],
      generatedTxGuids: [],
      protectedRows,
    };
  }

  function protectedRow(guid: string, txGuid: string, state: string) {
    return {
      guid, tx_guid: txGuid, account_guid: ACCOUNT,
      reconcile_state: state, account: { name: 'Assets:Brokerage' },
    };
  }

  /* --- THE PAIR THAT PROVES THE CLASSIFIER, not merely the guard --------- */

  it.each([
    ['reconciled', 'y'],
    ['frozen', 'f'],
  ])('BLOCKS a %s zero-value-trade revert (both legs tagged, both restored)', async (_label, state) => {
    // Each leg has a tagged sibling, so a sibling-count heuristic reads this
    // as "compensated" and lets both legs be rewritten from ±FMV back to
    // zero. The transaction stays balanced — so a balance check misses it —
    // but each account's reconciled balance moves. Must be refused.
    wireRun(zeroValueTradeRun([
      protectedRow(TRADE_LEG_A, TRADE_TX, state),
      protectedRow(TRADE_LEG_B, TRADE_TX, state),
    ]));
    prismaMock.slots.findFirst.mockResolvedValue({ string_val: '100' });

    await expect(revertScrubRun(RUN_ID)).rejects.toBeInstanceOf(ReconciledSplitError);
    expect(prismaMock.splits.update).not.toHaveBeenCalled();
  });

  it.each([
    ['reconciled', 'y'],
    ['frozen', 'f'],
  ])('ALLOWS a genuine %s partition revert (sub-split ROW deleted alongside)', async (_label, state) => {
    // Same co-tagging, opposite structure: SUB_SPLIT is a row the run created
    // and is deleting, and it sums back into the restored parent. Net zero on
    // the account, so the exemption stands.
    wireRun(partitionRun([
      protectedRow(ORIGINAL_SPLIT, SELL_TX, state),
      protectedRow(SUB_SPLIT, SELL_TX, state),
    ]));
    prismaMock.slots.findFirst.mockResolvedValue({ string_val: '100' });

    await expect(revertScrubRun(RUN_ID)).resolves.toMatchObject({ reverted: expect.any(Number) });
    expect(prismaMock.splits.update).toHaveBeenCalled();
  });

  it.each([
    ['reconciled', 'y'],
    ['frozen', 'f'],
  ])('BLOCKS %s trade legs even when a partitioned sale in the SAME transaction is compensated', async (_label, state) => {
    // The discriminating case. autoAssignLots uses ONE runId for every event
    // in an account, and one GnuCash transaction can carry several split
    // events — so a single parent transaction can hold BOTH a partitioned
    // sale (MIXED_SELL carved into MIXED_SUB, legitimately compensated) AND
    // an in-place zero-value-trade rewrite (TRADE_LEG_A/B).
    //
    // A per-TRANSACTION compensation count sees the sale's deleted sub-split,
    // decides "this transaction has compensation", and lets the trade legs be
    // restored from ±FMV back to zero while reconciled. Per-SPLIT provenance
    // is what stops it: MIXED_SUB names MIXED_SELL as its parent and nothing
    // names the trade legs, so only MIXED_SELL is exempt.
    wireRun({
      tagged: [
        { guid: MIXED_SELL, tx: MIXED_TX },
        { guid: MIXED_SUB, tx: MIXED_TX },
        { guid: TRADE_LEG_A, tx: MIXED_TX },
        { guid: TRADE_LEG_B, tx: MIXED_TX },
      ],
      // The sale's parent and both trade legs are restored in place; only
      // MIXED_SUB is a row being deleted.
      restored: [MIXED_SELL, TRADE_LEG_A, TRADE_LEG_B],
      generatedTxGuids: [],
      protectedRows: [
        protectedRow(TRADE_LEG_A, MIXED_TX, state),
        protectedRow(TRADE_LEG_B, MIXED_TX, state),
      ],
      parentOf: { [MIXED_SUB]: MIXED_SELL },
    });
    prismaMock.slots.findFirst.mockResolvedValue({ string_val: '100' });

    let thrown: unknown;
    await revertScrubRun(RUN_ID).catch(err => { thrown = err; });

    expect(thrown).toBeInstanceOf(ReconciledSplitError);
    const error = thrown as ReconciledSplitError;
    // Exactly the trade legs are named — not the compensated sale split.
    expect(error.splits.map(sp => sp.splitGuid).sort())
      .toEqual([TRADE_LEG_A, TRADE_LEG_B].sort());
    expect(prismaMock.splits.update).not.toHaveBeenCalled();
  });

  it('ALLOWS the compensated sale in that same mixed transaction once the trade legs are clean', async () => {
    // Same mixed shape, but nothing protected: the partition exemption still
    // applies, so the classifier is not merely blocking everything mixed.
    wireRun({
      tagged: [
        { guid: MIXED_SELL, tx: MIXED_TX },
        { guid: MIXED_SUB, tx: MIXED_TX },
        { guid: TRADE_LEG_A, tx: MIXED_TX },
        { guid: TRADE_LEG_B, tx: MIXED_TX },
      ],
      restored: [MIXED_SELL, TRADE_LEG_A, TRADE_LEG_B],
      generatedTxGuids: [],
      protectedRows: [],
      parentOf: { [MIXED_SUB]: MIXED_SELL },
    });
    prismaMock.slots.findFirst.mockResolvedValue({ string_val: '100' });

    await expect(revertScrubRun(RUN_ID)).resolves.toMatchObject({ reverted: expect.any(Number) });
    expect(prismaMock.splits.update).toHaveBeenCalled();
  });

  it('BLOCKS a partition restore whose sub-split names a DIFFERENT parent', async () => {
    // Provenance must match this split, not merely exist somewhere.
    wireRun({
      tagged: [
        { guid: ORIGINAL_SPLIT, tx: SELL_TX },
        { guid: SUB_SPLIT, tx: SELL_TX },
      ],
      restored: [ORIGINAL_SPLIT],
      generatedTxGuids: [],
      protectedRows: [protectedRow(ORIGINAL_SPLIT, SELL_TX, 'y')],
      parentOf: { [SUB_SPLIT]: 'someoneelse'.padEnd(32, '0') },
    });

    await expect(revertScrubRun(RUN_ID)).rejects.toBeInstanceOf(ReconciledSplitError);
  });

  it('BLOCKS a partition restore whose sub-split predates the provenance marker', async () => {
    // Legacy rows carry gnucash_web_generated but no parent slot. Fail closed
    // rather than guess that the deletion compensates this restore.
    wireRun({
      tagged: [
        { guid: ORIGINAL_SPLIT, tx: SELL_TX },
        { guid: SUB_SPLIT, tx: SELL_TX },
      ],
      restored: [ORIGINAL_SPLIT],
      generatedTxGuids: [],
      protectedRows: [protectedRow(ORIGINAL_SPLIT, SELL_TX, 'y')],
      parentOf: {},
    });

    await expect(revertScrubRun(RUN_ID)).rejects.toBeInstanceOf(ReconciledSplitError);
  });

  /* --- the rest of the policy -------------------------------------------- */

  it.each([
    ['reconciled', 'y'],
    ['frozen', 'f'],
  ])('refuses to delete a generated gains transaction with a %s split', async (_label, state) => {
    wireRun({
      tagged: [
        { guid: ORIGINAL_SPLIT, tx: SELL_TX },
        { guid: SUB_SPLIT, tx: SELL_TX },
        { guid: GAINS_SPLIT, tx: GAINS_TX },
      ],
      restored: [ORIGINAL_SPLIT],
      generatedTxGuids: [GAINS_TX],
      protectedRows: [protectedRow(GAINS_SPLIT, GAINS_TX, state)],
      parentOf: { [SUB_SPLIT]: ORIGINAL_SPLIT },
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
  ])('refuses a lone in-place restore of a %s split (fail-closed, no sibling at all)', async (_label, state) => {
    wireRun({
      tagged: [{ guid: ORIGINAL_SPLIT, tx: SELL_TX }],
      restored: [ORIGINAL_SPLIT],
      generatedTxGuids: [],
      protectedRows: [protectedRow(ORIGINAL_SPLIT, SELL_TX, state)],
    });

    await expect(revertScrubRun(RUN_ID)).rejects.toBeInstanceOf(ReconciledSplitError);
    expect(prismaMock.splits.update).not.toHaveBeenCalled();
  });

  it('stays fail-closed when the compensating sub-split tag is missing', async () => {
    // Corrupt/partial metadata: the parent is restored but its sub-split row
    // lost its tag, so nothing observable compensates the restore. Block.
    wireRun({
      tagged: [{ guid: ORIGINAL_SPLIT, tx: SELL_TX }],
      restored: [ORIGINAL_SPLIT],
      generatedTxGuids: [],
      protectedRows: [protectedRow(ORIGINAL_SPLIT, SELL_TX, 'y')],
    });

    await expect(revertScrubRun(RUN_ID)).rejects.toBeInstanceOf(ReconciledSplitError);
  });

  it('reverts normally when nothing is reconciled', async () => {
    wireRun({
      tagged: [
        { guid: ORIGINAL_SPLIT, tx: SELL_TX },
        { guid: SUB_SPLIT, tx: SELL_TX },
        { guid: GAINS_SPLIT, tx: GAINS_TX },
      ],
      restored: [ORIGINAL_SPLIT],
      generatedTxGuids: [GAINS_TX],
      protectedRows: [],
      parentOf: { [SUB_SPLIT]: ORIGINAL_SPLIT },
    });
    prismaMock.slots.findFirst.mockResolvedValue({ string_val: '100' });

    await expect(revertScrubRun(RUN_ID)).resolves.toMatchObject({ reverted: expect.any(Number) });
    expect(prismaMock.transactions.deleteMany).toHaveBeenCalled();
  });

  it('locks every affected parent transaction FOR UPDATE before the policy read', async () => {
    // NOTE (see the file header): this asserts call ORDER against mocks. It
    // pins that the lock statement is issued before the read, which is the
    // regression that keeps recurring. It does NOT prove PostgreSQL actually
    // holds the row lock.
    wireRun({
      tagged: [
        { guid: ORIGINAL_SPLIT, tx: SELL_TX },
        { guid: SUB_SPLIT, tx: SELL_TX },
        { guid: GAINS_SPLIT, tx: GAINS_TX },
      ],
      restored: [ORIGINAL_SPLIT],
      generatedTxGuids: [GAINS_TX],
      protectedRows: [],
      parentOf: { [SUB_SPLIT]: ORIGINAL_SPLIT },
    });
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
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0])
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
