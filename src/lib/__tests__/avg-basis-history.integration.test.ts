/**
 * REAL POSTGRESQL exercise of the average-cost history store.
 *
 * The unit tier drives this module through an in-memory Prisma stand-in, which
 * can only ever prove that the CODE around the statements is right. Everything
 * this file asserts is a property of the statements themselves: the composite
 * primary key, the `COALESCE(MAX(seq_no) + 1, 0)` append, the `ANY(...::text[])`
 * delete, the `run_id` lookup, and the fact that a value with no numeric
 * meaning survives a round trip through a real `text` column unchanged.
 *
 * Cleanup follows the tier convention (see vitest.integration.config.ts): every
 * row is tagged with a per-run id and deleted in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import prisma from '../prisma';
import {
  appendAvgBasisHistory,
  deleteAvgBasisHistoryForAccounts,
  deleteAvgBasisHistoryForDeletedLots,
  deleteAvgBasisHistoryForLots,
  ensureAvgBasisHistoryTable,
  hasAvgBasisHistory,
  lotsWithAvgBasisHistoryForRun,
  popAvgBasisHistoryTopForRun,
  readAvgBasisHistory,
  replaceAvgBasisHistory,
  type AvgBasisWrite,
} from '../avg-basis-history';
import type { PrismaTx } from '../lot-scrub';

/** Per-run prefix so two runs, or a leftover, cannot collide. */
const RUN_TAG = randomUUID().replace(/-/g, '').slice(0, 12);
const lotGuid = (n: number) => `${RUN_TAG}lot${String(n).padStart(4, '0')}`.slice(0, 32);
const runGuid = (n: number) => `${RUN_TAG}run${String(n).padStart(4, '0')}`.slice(0, 32);

const tx = prisma as unknown as PrismaTx;

beforeAll(async () => {
  await ensureAvgBasisHistoryTable();
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(
    'DELETE FROM gnucash_web_avg_basis_history WHERE lot_guid LIKE $1',
    `${RUN_TAG}%`,
  );
  await prisma.$disconnect();
});

describe('gnucash_web_avg_basis_history against real PostgreSQL', () => {
  it('creates its table idempotently', async () => {
    // Second call must be a no-op, not an error, on a database that has it.
    await ensureAvgBasisHistoryTable();
    const [{ count }] = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
        FROM information_schema.columns
       WHERE table_name = 'gnucash_web_avg_basis_history'
    `;
    expect(Number(count)).toBe(5);
  });

  it('appends in order and reads the stack back oldest first', async () => {
    const lot = lotGuid(1);
    for (let i = 0; i < 5; i++) {
      await appendAvgBasisHistory(lot, { run: runGuid(i), value: String(1000 + i) }, tx);
    }
    const stack = await readAvgBasisHistory(lot, tx);
    expect(stack.map(e => e.value)).toEqual(['1000', '1001', '1002', '1003', '1004']);
    expect(stack.map(e => e.run)).toEqual([0, 1, 2, 3, 4].map(runGuid));
    expect(stack.every(e => e.corrupt === undefined)).toBe(true);
  });

  it('has no 4096-character ceiling: 500 writes on one lot', async () => {
    const lot = lotGuid(2);
    const stack: AvgBasisWrite[] = Array.from({ length: 500 }, (_, i) => ({
      run: runGuid(i),
      value: String(2000 + i),
    }));
    await replaceAvgBasisHistory(lot, stack, tx);

    const read = await readAvgBasisHistory(lot, tx);
    expect(read).toHaveLength(500);
    expect(read[0].value).toBe('2000');
    expect(read[499].value).toBe('2499');
    // The equivalent JSON document would be far past what the slot column holds.
    expect(JSON.stringify(stack).length).toBeGreaterThan(4096);
  });

  it('pops the top only when this run owns it', async () => {
    const lot = lotGuid(3);
    await appendAvgBasisHistory(lot, { run: runGuid(1), value: '10' }, tx);
    await appendAvgBasisHistory(lot, { run: runGuid(2), value: '20' }, tx);

    // Not the top: nothing happens.
    await popAvgBasisHistoryTopForRun(lot, runGuid(1), tx);
    expect((await readAvgBasisHistory(lot, tx)).map(e => e.value)).toEqual(['10', '20']);

    // The top: superseded.
    await popAvgBasisHistoryTopForRun(lot, runGuid(2), tx);
    expect((await readAvgBasisHistory(lot, tx)).map(e => e.value)).toEqual(['10']);

    // And the next append reuses the freed slot number rather than skipping it.
    await appendAvgBasisHistory(lot, { run: runGuid(2), value: '30' }, tx);
    const rows = await prisma.$queryRaw<Array<{ seq_no: number }>>`
      SELECT seq_no FROM gnucash_web_avg_basis_history
       WHERE lot_guid = ${lot} ORDER BY seq_no
    `;
    expect(rows.map(r => r.seq_no)).toEqual([0, 1]);
  });

  it('stores a NULL owner for a legacy write', async () => {
    const lot = lotGuid(4);
    await appendAvgBasisHistory(lot, { run: null, value: '77.5' }, tx);
    const [entry] = await readAvgBasisHistory(lot, tx);
    expect(entry).toEqual({ run: null, value: '77.5' });
  });

  it('round-trips a non-numeric value unchanged and flags it', async () => {
    const lot = lotGuid(5);
    await replaceAvgBasisHistory(lot, [
      { run: runGuid(1), value: '100' },
      { run: runGuid(2), value: '10{7' },
      { run: runGuid(3), value: '300' },
    ], tx);
    const stack = await readAvgBasisHistory(lot, tx);
    // The damaged row is kept exactly as stored - a repair has to be able to
    // see it - and only IT is flagged.
    expect(stack.map(e => e.value)).toEqual(['100', '10{7', '300']);
    expect(stack.map(e => e.corrupt ?? false)).toEqual([false, true, false]);
  });

  it('finds every lot a run wrote to, through the run_id index', async () => {
    const shared = runGuid(900);
    const lots = [lotGuid(10), lotGuid(11), lotGuid(12)];
    for (const lot of lots) {
      await appendAvgBasisHistory(lot, { run: runGuid(800), value: '1' }, tx);
      await appendAvgBasisHistory(lot, { run: shared, value: '2' }, tx);
    }
    const found = await lotsWithAvgBasisHistoryForRun(shared, tx);
    expect([...found].sort()).toEqual([...lots].sort());
  });

  it('deletes by lot list and reports presence', async () => {
    const [a, b] = [lotGuid(20), lotGuid(21)];
    await appendAvgBasisHistory(a, { run: runGuid(1), value: '1' }, tx);
    await appendAvgBasisHistory(b, { run: runGuid(1), value: '2' }, tx);
    expect(await hasAvgBasisHistory(a, tx)).toBe(true);

    await deleteAvgBasisHistoryForLots([a], tx);
    expect(await hasAvgBasisHistory(a, tx)).toBe(false);
    expect(await hasAvgBasisHistory(b, tx)).toBe(true);

    // An empty list must be a no-op, not "delete everything".
    await deleteAvgBasisHistoryForLots([], tx);
    expect(await hasAvgBasisHistory(b, tx)).toBe(true);
  });

  it('replaces a stack atomically, renumbering from zero', async () => {
    const lot = lotGuid(30);
    await replaceAvgBasisHistory(lot, [
      { run: runGuid(1), value: '1' },
      { run: runGuid(2), value: '2' },
      { run: runGuid(3), value: '3' },
    ], tx);
    // Drop the middle entry, the way a revert does.
    const kept = (await readAvgBasisHistory(lot, tx)).filter(e => e.run !== runGuid(2));
    await replaceAvgBasisHistory(lot, kept, tx);

    const rows = await prisma.$queryRaw<Array<{ seq_no: number; basis_val: string }>>`
      SELECT seq_no, basis_val FROM gnucash_web_avg_basis_history
       WHERE lot_guid = ${lot} ORDER BY seq_no
    `;
    expect(rows).toEqual([
      { seq_no: 0, basis_val: '1' },
      { seq_no: 1, basis_val: '3' },
    ]);
  });
});

/**
 * ORPHAN CLEANUP.
 *
 * GnuCash lot GUIDs are stable across an XML export/import cycle, so
 * re-importing an older snapshot of a book — a routine restore — recreates
 * lots under GUIDs that already exist. The history table is keyed by lot GUID
 * and has no FK to `lots`, so anything left behind silently attaches itself to
 * the incoming lot. `readLiveAvgBasisRemaining` then sees "history rows but no
 * live slot" on a perfectly healthy book and raises the repair-required error
 * (HTTP 422). The guard is right; the orphan is the defect.
 *
 * These two statements are what stop that, and both are exercised here rather
 * than only against an in-memory fake: one resolves lots through a subquery
 * over `lots`, the other through `ANY(...::text[])`, and neither shape is
 * meaningfully tested without a real planner.
 */
describe('orphan cleanup against real PostgreSQL', () => {
    const ACCT_A = `${RUN_TAG}acctA`.padEnd(20, '0').slice(0, 32);
    const ACCT_B = `${RUN_TAG}acctB`.padEnd(20, '0').slice(0, 32);
    const LOT_A1 = `${RUN_TAG}lotA1`.padEnd(20, '0').slice(0, 32);
    const LOT_A2 = `${RUN_TAG}lotA2`.padEnd(20, '0').slice(0, 32);
    const LOT_B1 = `${RUN_TAG}lotB1`.padEnd(20, '0').slice(0, 32);

    beforeAll(async () => {
        for (const [guid, name] of [[ACCT_A, 'A'], [ACCT_B, 'B']] as const) {
            await prisma.$executeRawUnsafe(
                `INSERT INTO accounts (guid, name, account_type, commodity_scu, non_std_scu)
                 VALUES ($1, $2, 'STOCK', 100, 0) ON CONFLICT (guid) DO NOTHING`,
                guid, `avg-basis-it-${name}`,
            );
        }
        for (const [lotGuid, acct] of [
            [LOT_A1, ACCT_A], [LOT_A2, ACCT_A], [LOT_B1, ACCT_B],
        ] as const) {
            await prisma.$executeRawUnsafe(
                `INSERT INTO lots (guid, account_guid, is_closed) VALUES ($1, $2, 0)
                 ON CONFLICT (guid) DO NOTHING`,
                lotGuid, acct,
            );
        }
    });

    afterAll(async () => {
        await prisma.$executeRawUnsafe(
            `DELETE FROM lots WHERE guid = ANY($1::text[])`, [LOT_A1, LOT_A2, LOT_B1],
        );
        await prisma.$executeRawUnsafe(
            `DELETE FROM accounts WHERE guid = ANY($1::text[])`, [ACCT_A, ACCT_B],
        );
    });

    const seedAll = async () => {
        for (const guid of [LOT_A1, LOT_A2, LOT_B1]) {
            await replaceAvgBasisHistory(guid, [{ run: runGuid(1), value: '100' }], tx);
        }
    };

    it('deletes by lot list and leaves every other lot alone', async () => {
        await seedAll();
        const removed = await deleteAvgBasisHistoryForDeletedLots([LOT_A1], tx);
        expect(removed).toBe(1);
        expect(await hasAvgBasisHistory(LOT_A1, tx)).toBe(false);
        expect(await hasAvgBasisHistory(LOT_A2, tx)).toBe(true);
        expect(await hasAvgBasisHistory(LOT_B1, tx)).toBe(true);
    });

    it('deletes every lot of the given accounts, and only those', async () => {
        await seedAll();
        const removed = await deleteAvgBasisHistoryForAccounts([ACCT_A], tx);
        // Both of account A's lots; account B untouched.
        expect(removed).toBe(2);
        expect(await hasAvgBasisHistory(LOT_A1, tx)).toBe(false);
        expect(await hasAvgBasisHistory(LOT_A2, tx)).toBe(false);
        expect(await hasAvgBasisHistory(LOT_B1, tx)).toBe(true);
    });

    it('is a no-op on an empty list rather than deleting everything', async () => {
        await seedAll();
        expect(await deleteAvgBasisHistoryForDeletedLots([], tx)).toBe(0);
        expect(await deleteAvgBasisHistoryForAccounts([], tx)).toBe(0);
        for (const guid of [LOT_A1, LOT_A2, LOT_B1]) {
            expect(await hasAvgBasisHistory(guid, tx)).toBe(true);
        }
        await deleteAvgBasisHistoryForLots([LOT_A1, LOT_A2, LOT_B1], tx);
    });

    it('finds nothing to delete for an account with no lots', async () => {
        await seedAll();
        const unknownAccount = `${RUN_TAG}nosuch`.padEnd(20, '0').slice(0, 32);
        expect(await deleteAvgBasisHistoryForAccounts([unknownAccount], tx)).toBe(0);
        expect(await hasAvgBasisHistory(LOT_A1, tx)).toBe(true);
        await deleteAvgBasisHistoryForLots([LOT_A1, LOT_A2, LOT_B1], tx);
    });
});
