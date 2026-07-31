import { describe, expect, it, vi } from 'vitest';
import {
  createBudgetOwnership,
  deleteOwnedBudgetsForBook,
  isBudgetOwnedByBook,
} from '@/lib/budget-ownership';

const BOOK = 'a'.repeat(32);
const BUDGET = 'b'.repeat(32);

function client(ownerBook: string | null = BOOK) {
  return {
    gnucash_web_budget_ownership: {
      create: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => ownerBook ? { book_guid: ownerBook } : null),
      findMany: vi.fn(async () => [{ budget_guid: BUDGET }]),
    },
    recurrences: {
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    budgets: {
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  };
}

describe('budget ownership lifecycle', () => {
  it('persists one explicit owner', async () => {
    const db = client();
    await createBudgetOwnership(db, BUDGET, BOOK);
    expect(db.gnucash_web_budget_ownership.create).toHaveBeenCalledWith({
      data: { budget_guid: BUDGET, book_guid: BOOK },
    });
  });

  it('treats foreign and missing ownership as not owned', async () => {
    await expect(isBudgetOwnedByBook(client('c'.repeat(32)), BUDGET, BOOK)).resolves.toBe(false);
    await expect(isBudgetOwnedByBook(client(null), BUDGET, BOOK)).resolves.toBe(false);
  });

  it('deletes recurrences before owned native budgets', async () => {
    const db = client();
    const order: string[] = [];
    db.recurrences.deleteMany.mockImplementation(async () => {
      order.push('recurrences');
      return { count: 1 };
    });
    db.budgets.deleteMany.mockImplementation(async () => {
      order.push('budgets');
      return { count: 1 };
    });

    await expect(deleteOwnedBudgetsForBook(db, BOOK)).resolves.toEqual([BUDGET]);
    expect(order).toEqual(['recurrences', 'budgets']);
  });
});
