/**
 * Scheduled transactions must post splits that sum to exactly zero.
 *
 * Both the template writer (scheduled-tx-create) and the occurrence writer
 * (scheduled-tx-execute) used to round every split independently, so a
 * balanced set of finer-than-cent amounts wrote a residual imbalance into the
 * books with nothing to reject it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../prisma', () => {
  const mockTx = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  };

  return {
    default: {
      $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
      accounts: {
        findMany: vi.fn(({ where }: { where: { guid: { in: string[] } } }) =>
          Promise.resolve(where.guid.in.map((guid: string) => ({ guid })))),
      },
      __mockTx: mockTx,
    },
  };
});

vi.mock('../scheduled-transactions', () => ({
  resolveTemplateSplits: vi.fn(),
}));

vi.mock('../gnucash', () => {
  let guidCounter = 0;
  return {
    generateGuid: vi.fn(() => `guid${String(++guidCounter).padStart(29, '0')}`),
  };
});

vi.mock('../services/audit.service', () => ({
  logAudit: vi.fn(),
}));

vi.mock('../book-scope', () => ({
  getAccountGuidsForBook: vi.fn(async () => []),
}));

import prisma from '../prisma';
import { resolveTemplateSplits } from '../scheduled-transactions';
import {
  balanceSplitNumerators,
  executeOccurrence,
} from '../services/scheduled-tx-execute';
import {
  createScheduledTransaction,
  type CreateScheduledTxInput,
} from '../services/scheduled-tx-create';

const mockTx = (prisma as unknown as {
  __mockTx: { $queryRaw: ReturnType<typeof vi.fn>; $executeRaw: ReturnType<typeof vi.fn> };
}).__mockTx;

/**
 * Prisma tagged templates are invoked as (strings, ...values). Pull the
 * value_num numerator out of every `INSERT INTO splits` call: the parameter
 * order is guid, tx_guid, account_guid, value_num, value_denom, ...
 */
function insertedSplitNumerators(): number[] {
  return mockTx.$executeRaw.mock.calls
    .filter((call: unknown[]) => (call[0] as string[]).join('').includes('INSERT INTO splits'))
    .map((call: unknown[]) => Number(call[4]));
}

function insertedSplitDenominators(): number[] {
  return mockTx.$executeRaw.mock.calls
    .filter((call: unknown[]) => (call[0] as string[]).join('').includes('INSERT INTO splits'))
    .map((call: unknown[]) => Number(call[5]));
}

describe('balanceSplitNumerators', () => {
  it('assigns the rounding residual instead of dropping it (1e6 template)', () => {
    const result = balanceSplitNumerators([33.333333, 33.333333, 33.333334, -100.0]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nums.reduce((sum, n) => sum + n, 0)).toBe(0);
    // Independent rounding gave 3333 + 3333 + 3333 - 10000 = -1 cent.
    expect(result.nums).toEqual([3333, 3333, 3333, -9999]);
  });

  it('balances a set that sums to zero as floats but not as cents', () => {
    const result = balanceSplitNumerators([0.334, 0.333, -0.667]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nums.reduce((sum, n) => sum + n, 0)).toBe(0);
    expect(result.nums).toEqual([33, 33, -66]);
  });

  it('leaves an already-exact set untouched', () => {
    const result = balanceSplitNumerators([1000, -1000]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nums).toEqual([100_000, -100_000]);
  });

  it('rejects a genuinely unbalanced set rather than rewriting an amount', () => {
    const result = balanceSplitNumerators([1000, -500]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/balance/i);
  });

  it('rejects non-finite amounts', () => {
    expect(balanceSplitNumerators([Number.NaN, 0]).ok).toBe(false);
  });

  it('honours a non-cent denominator', () => {
    const result = balanceSplitNumerators([0.3333, 0.3333, -0.6666], 10_000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nums).toEqual([3333, 3333, -6666]);
  });
});

describe('executeOccurrence writes balanced splits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts sum(value_num) === 0 for a sub-cent template', async () => {
    const sxGuid = 'sx0000000000000000000000000bal1';

    mockTx.$queryRaw.mockResolvedValueOnce([
      {
        guid: sxGuid,
        name: 'Three-way Split',
        template_act_guid: 'tmpl000000000000000000000bal1',
        last_occur: null,
        rem_occur: -1,
        instance_count: 0,
      },
    ]);
    vi.mocked(resolveTemplateSplits).mockResolvedValueOnce([
      { accountGuid: 'a1', accountName: 'Expenses:A', amount: 33.333333, templateAccountGuid: 't1' },
      { accountGuid: 'a2', accountName: 'Expenses:B', amount: 33.333333, templateAccountGuid: 't2' },
      { accountGuid: 'a3', accountName: 'Expenses:C', amount: 33.333334, templateAccountGuid: 't3' },
      { accountGuid: 'a4', accountName: 'Assets:Checking', amount: -100.0, templateAccountGuid: 't4' },
    ]);
    mockTx.$queryRaw.mockResolvedValueOnce([{ commodity_guid: 'usd0000000000000000000000001' }]);
    mockTx.$executeRaw.mockResolvedValue(1);

    const result = await executeOccurrence(sxGuid, '2026-03-01');

    expect(result.success).toBe(true);

    const nums = insertedSplitNumerators();
    expect(nums).toEqual([3333, 3333, 3333, -9999]);
    expect(nums.reduce((sum, n) => sum + n, 0)).toBe(0);
    expect(insertedSplitDenominators()).toEqual([100, 100, 100, 100]);
  });

  it('refuses to post a template whose splits do not balance', async () => {
    const sxGuid = 'sx0000000000000000000000000bal2';

    mockTx.$queryRaw.mockResolvedValueOnce([
      {
        guid: sxGuid,
        name: 'Broken Template',
        template_act_guid: 'tmpl000000000000000000000bal2',
        last_occur: null,
        rem_occur: -1,
        instance_count: 0,
      },
    ]);
    vi.mocked(resolveTemplateSplits).mockResolvedValueOnce([
      { accountGuid: 'a1', accountName: 'Expenses:A', amount: 100, templateAccountGuid: 't1' },
      { accountGuid: 'a2', accountName: 'Assets:Checking', amount: -90, templateAccountGuid: 't2' },
    ]);
    mockTx.$executeRaw.mockResolvedValue(1);

    const result = await executeOccurrence(sxGuid, '2026-03-01');

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/balance/i);
    // Nothing written — not the transaction, not the metadata update.
    expect(mockTx.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('createScheduledTransaction writes balanced template splits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeInput(splits: CreateScheduledTxInput['splits']): CreateScheduledTxInput {
    return {
      name: 'Thirds',
      startDate: '2026-04-01',
      endDate: null,
      recurrence: {
        periodType: 'month',
        mult: 1,
        periodStart: '2026-04-01',
        weekendAdjust: 'none',
      },
      splits,
      autoCreate: false,
      autoNotify: false,
    };
  }

  it('rounds the set, not each split, so the template balances in cents', async () => {
    mockTx.$queryRaw.mockResolvedValueOnce([{ guid: 'templateroot0000000000000001' }]);
    mockTx.$queryRaw.mockResolvedValueOnce([{ commodity_guid: 'usd0000000000000000000000001' }]);
    mockTx.$executeRaw.mockResolvedValue(1);

    const result = await createScheduledTransaction(makeInput([
      { accountGuid: 'acct000000000000000000000001', amount: 0.334 },
      { accountGuid: 'acct000000000000000000000002', amount: 0.333 },
      { accountGuid: 'acct000000000000000000000003', amount: -0.667 },
    ]));

    expect(result.success).toBe(true);

    const nums = insertedSplitNumerators();
    // Was 33 + 33 - 67 = -1 cent.
    expect(nums).toEqual([33, 33, -66]);
    expect(nums.reduce((sum, n) => sum + n, 0)).toBe(0);
  });

  it('rejects a set that only balances as floats beyond rounding error', async () => {
    const result = await createScheduledTransaction(makeInput([
      { accountGuid: 'acct000000000000000000000001', amount: 10 },
      { accountGuid: 'acct000000000000000000000002', amount: -9.9 },
    ]));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/balance/i);
    expect(mockTx.$executeRaw).not.toHaveBeenCalled();
  });
});
