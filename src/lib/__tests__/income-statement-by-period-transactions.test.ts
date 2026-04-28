import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Prisma mock -----------------------------------------------------------
const mockAccountsFindMany = vi.fn();
const mockSplitsFindMany = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    accounts: {
      findMany: (...args: unknown[]) => mockAccountsFindMany(...args),
    },
    splits: {
      findMany: (...args: unknown[]) => mockSplitsFindMany(...args),
    },
  },
}));

import { fetchPeriodTransactions } from '../reports/income-statement-by-period-transactions';

// --- Helpers --------------------------------------------------------------

function acct(guid: string, name: string, parent: string | null, type: 'INCOME' | 'EXPENSE') {
  return { guid, name, account_type: type, parent_guid: parent, hidden: 0 };
}

function split(opts: {
  txGuid: string;
  splitGuid: string;
  acctGuid: string;
  num: bigint;
  denom: bigint;
  date: string;
  description: string;
}) {
  return {
    guid: opts.splitGuid,
    tx_guid: opts.txGuid,
    account_guid: opts.acctGuid,
    quantity_num: opts.num,
    quantity_denom: opts.denom,
    transaction: {
      post_date: new Date(opts.date + 'T12:00:00Z'),
      enter_date: new Date(opts.date + 'T12:00:00Z'),
      description: opts.description,
    },
  };
}

beforeEach(() => {
  mockAccountsFindMany.mockReset();
  mockSplitsFindMany.mockReset();
});

// --- Tests ----------------------------------------------------------------

describe('fetchPeriodTransactions', () => {
  it('returns transactions for a leaf INCOME account with sign flipped', async () => {
    mockAccountsFindMany.mockResolvedValueOnce([
      acct('income-root', 'Income', 'root', 'INCOME'),
      acct('salary', 'Salary', 'income-root', 'INCOME'),
    ]);
    mockSplitsFindMany.mockResolvedValueOnce([
      split({ txGuid: 't1', splitGuid: 's1', acctGuid: 'salary', num: -500000n, denom: 100n, date: '2026-03-15', description: 'Paycheck' }),
    ]);

    const result = await fetchPeriodTransactions({
      accountGuid: 'salary',
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    });

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      txGuid: 't1',
      splitGuid: 's1',
      date: '2026-03-15',
      description: 'Paycheck',
      accountGuid: 'salary',
      accountName: 'Salary',
      amount: 5000,
    });
    expect(result.total).toBeCloseTo(5000, 2);
  });

  it('rolls up descendants for a parent account click', async () => {
    mockAccountsFindMany.mockResolvedValueOnce([
      acct('income-root', 'Income', 'root', 'INCOME'),
      acct('wages', 'Wages', 'income-root', 'INCOME'),
      acct('salary', 'Salary', 'wages', 'INCOME'),
      acct('bonus', 'Bonus', 'wages', 'INCOME'),
    ]);
    mockSplitsFindMany.mockResolvedValueOnce([
      split({ txGuid: 't1', splitGuid: 's1', acctGuid: 'salary', num: -500000n, denom: 100n, date: '2026-03-15', description: 'Paycheck' }),
      split({ txGuid: 't2', splitGuid: 's2', acctGuid: 'bonus',  num: -100000n, denom: 100n, date: '2026-03-20', description: 'Bonus' }),
    ]);

    const result = await fetchPeriodTransactions({
      accountGuid: 'wages',
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    });

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions.map(t => t.accountName).sort()).toEqual(['Bonus', 'Salary']);
    expect(result.total).toBeCloseTo(6000, 2);
    // Splits query should have been called with all three in-scope guids
    const splitsArgs = mockSplitsFindMany.mock.calls[0][0];
    expect(splitsArgs.where.account_guid.in.sort()).toEqual(['bonus', 'salary', 'wages'].sort());
  });

  it('does NOT flip sign for EXPENSE accounts', async () => {
    mockAccountsFindMany.mockResolvedValueOnce([
      acct('exp-root', 'Expenses', 'root', 'EXPENSE'),
      acct('groceries', 'Groceries', 'exp-root', 'EXPENSE'),
    ]);
    mockSplitsFindMany.mockResolvedValueOnce([
      split({ txGuid: 't1', splitGuid: 's1', acctGuid: 'groceries', num: 12345n, denom: 100n, date: '2026-03-10', description: 'Store' }),
    ]);

    const result = await fetchPeriodTransactions({
      accountGuid: 'groceries',
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    });

    expect(result.transactions[0].amount).toBeCloseTo(123.45, 2);
    expect(result.total).toBeCloseTo(123.45, 2);
  });

  it('emits one row per split when a single transaction has multiple in-scope splits', async () => {
    mockAccountsFindMany.mockResolvedValueOnce([
      acct('income-root', 'Income', 'root', 'INCOME'),
      acct('wages', 'Wages', 'income-root', 'INCOME'),
      acct('salary', 'Salary', 'wages', 'INCOME'),
      acct('bonus', 'Bonus', 'wages', 'INCOME'),
    ]);
    mockSplitsFindMany.mockResolvedValueOnce([
      split({ txGuid: 't1', splitGuid: 's1a', acctGuid: 'salary', num: -400000n, denom: 100n, date: '2026-03-15', description: 'Payroll' }),
      split({ txGuid: 't1', splitGuid: 's1b', acctGuid: 'bonus',  num: -100000n, denom: 100n, date: '2026-03-15', description: 'Payroll' }),
    ]);

    const result = await fetchPeriodTransactions({
      accountGuid: 'wages',
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    });

    expect(result.transactions).toHaveLength(2);
    expect(result.total).toBeCloseTo(5000, 2);
  });

  it('returns empty when accountGuid is unknown', async () => {
    mockAccountsFindMany.mockResolvedValueOnce([
      acct('income-root', 'Income', 'root', 'INCOME'),
    ]);

    const result = await fetchPeriodTransactions({
      accountGuid: 'does-not-exist',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });

    expect(result.transactions).toEqual([]);
    expect(result.total).toBe(0);
    expect(mockSplitsFindMany).not.toHaveBeenCalled();
  });

  it('passes bookAccountGuids through to the accounts query', async () => {
    mockAccountsFindMany.mockResolvedValueOnce([
      acct('salary', 'Salary', 'root', 'INCOME'),
    ]);
    mockSplitsFindMany.mockResolvedValueOnce([]);

    await fetchPeriodTransactions({
      accountGuid: 'salary',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      bookAccountGuids: ['salary', 'root'],
    });

    const acctArgs = mockAccountsFindMany.mock.calls[0][0];
    expect(acctArgs.where.guid).toEqual({ in: ['salary', 'root'] });
  });
});
