import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    budgets: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
    },
    recurrences: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    budget_amounts: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    gnucash_web_budget_ownership: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  };

  return {
    tx,
    prisma: {
      ...tx,
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    },
    getAccountGuidsForBook: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({ default: mocks.prisma }));
vi.mock('@/lib/book-scope', () => ({
  getAccountGuidsForBook: mocks.getAccountGuidsForBook,
}));

import { BudgetService } from '../budget.service';

const BOOK_A = 'a'.repeat(32);
const BOOK_B = 'b'.repeat(32);
const BUDGET = 'c'.repeat(32);
const ACCOUNT = 'd'.repeat(32);
const FOREIGN_ACCOUNT = 'e'.repeat(32);

describe('BudgetService book ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      async (operation: (client: typeof mocks.tx) => unknown) => operation(mocks.tx),
    );
    mocks.getAccountGuidsForBook.mockResolvedValue([ACCOUNT]);
  });

  it('lists only budget GUIDs owned by the requested book', async () => {
    mocks.prisma.gnucash_web_budget_ownership.findMany.mockResolvedValue([
      { budget_guid: BUDGET },
    ]);
    mocks.prisma.budgets.findMany.mockResolvedValue([]);

    await BudgetService.list(BOOK_A);

    expect(mocks.prisma.gnucash_web_budget_ownership.findMany).toHaveBeenCalledWith({
      where: { book_guid: BOOK_A },
      select: { budget_guid: true },
    });
    expect(mocks.prisma.budgets.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { guid: { in: [BUDGET] } },
        include: expect.objectContaining({
          _count: {
            select: {
              amounts: {
                where: { account_guid: { in: [ACCOUNT] } },
              },
            },
          },
        }),
      }),
    );
  });

  it('returns null without reading a foreign budget', async () => {
    mocks.prisma.gnucash_web_budget_ownership.findUnique.mockResolvedValue({
      book_guid: BOOK_B,
    });

    await expect(BudgetService.getById(BOOK_A, BUDGET)).resolves.toBeNull();
    expect(mocks.prisma.budgets.findUnique).not.toHaveBeenCalled();
  });

  it('never returns a foreign account amount from an owned budget', async () => {
    mocks.prisma.gnucash_web_budget_ownership.findUnique.mockResolvedValue({
      book_guid: BOOK_A,
    });
    mocks.prisma.budgets.findUnique.mockResolvedValue({
      guid: BUDGET,
      name: 'Corrupt native budget',
      description: null,
      num_periods: 12,
      recurrences: [],
      amounts: [
        {
          id: 1,
          budget_guid: BUDGET,
          account_guid: ACCOUNT,
          period_num: 0,
          amount_num: 100n,
          amount_denom: 1n,
          account: {
            guid: ACCOUNT,
            name: 'Owned',
            parent_guid: null,
            commodity: { mnemonic: 'USD' },
          },
        },
        {
          id: 2,
          budget_guid: BUDGET,
          account_guid: FOREIGN_ACCOUNT,
          period_num: 0,
          amount_num: 999n,
          amount_denom: 1n,
          account: {
            guid: FOREIGN_ACCOUNT,
            name: 'Foreign',
            parent_guid: null,
            commodity: { mnemonic: 'USD' },
          },
        },
      ],
    });

    const budget = await BudgetService.getById(BOOK_A, BUDGET);

    expect(mocks.prisma.budgets.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          amounts: expect.objectContaining({
            where: { account_guid: { in: [ACCOUNT] } },
          }),
        }),
      }),
    );
    expect(budget?.amounts).toHaveLength(1);
    expect(budget?.amounts[0].account_guid).toBe(ACCOUNT);
  });

  it('performs zero writes when mutation ownership does not match', async () => {
    mocks.tx.gnucash_web_budget_ownership.findUnique.mockResolvedValue({
      book_guid: BOOK_B,
    });

    await expect(
      BudgetService.update(BOOK_A, BUDGET, { name: 'Blocked' }),
    ).rejects.toThrow(`Budget not found: ${BUDGET}`);
    expect(mocks.tx.budgets.update).not.toHaveBeenCalled();
  });

  it('rejects a foreign account before opening a write transaction', async () => {
    mocks.getAccountGuidsForBook.mockResolvedValue([]);

    await expect(
      BudgetService.setAmount(BOOK_A, BUDGET, ACCOUNT, 0, 12.34),
    ).rejects.toThrow(`Account not found: ${ACCOUNT}`);
    expect(mocks.getAccountGuidsForBook).toHaveBeenCalledWith(BOOK_A);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.tx.budget_amounts.upsert).not.toHaveBeenCalled();
  });

  it('creates the budget and immutable ownership in one transaction', async () => {
    mocks.tx.budgets.create.mockImplementation(async ({ data }) => data);
    mocks.tx.gnucash_web_budget_ownership.create.mockResolvedValue({});
    mocks.tx.recurrences.create.mockResolvedValue({});

    const created = await BudgetService.create(BOOK_A, {
      name: 'Scoped budget',
      description: '',
      num_periods: 12,
      period_type: 'month',
      mult: 1,
    });

    expect(mocks.prisma.$transaction).toHaveBeenCalledOnce();
    expect(mocks.tx.gnucash_web_budget_ownership.create).toHaveBeenCalledWith({
      data: {
        budget_guid: created.guid,
        book_guid: BOOK_A,
      },
    });
  });
});
