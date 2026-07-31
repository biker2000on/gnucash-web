interface OwnershipClient {
  gnucash_web_budget_ownership: {
    create(args: {
      data: { budget_guid: string; book_guid: string };
    }): Promise<unknown>;
    findUnique(args: {
      where: { budget_guid: string };
      select: { book_guid: true };
    }): Promise<{ book_guid: string } | null>;
    findMany(args: {
      where: { book_guid: string };
      select: { budget_guid: true };
    }): Promise<Array<{ budget_guid: string }>>;
  };
}

interface OwnershipLifecycleClient extends OwnershipClient {
  recurrences: {
    deleteMany(args: {
      where: { obj_guid: { in: string[] } };
    }): Promise<unknown>;
  };
  budgets: {
    deleteMany(args: {
      where: { guid: { in: string[] } };
    }): Promise<unknown>;
  };
}

/**
 * Persist the immutable app-side owner for a native GnuCash budget.
 * Callers must use the same transaction that creates the budget row.
 */
export async function createBudgetOwnership(
  db: OwnershipClient,
  budgetGuid: string,
  bookGuid: string,
): Promise<void> {
  await db.gnucash_web_budget_ownership.create({
    data: {
      budget_guid: budgetGuid,
      book_guid: bookGuid,
    },
  });
}

/**
 * True only when the budget is explicitly owned by the requested book.
 * Missing and foreign ownership intentionally have identical semantics.
 */
export async function isBudgetOwnedByBook(
  db: OwnershipClient,
  budgetGuid: string,
  bookGuid: string,
): Promise<boolean> {
  const ownership = await db.gnucash_web_budget_ownership.findUnique({
    where: { budget_guid: budgetGuid },
    select: { book_guid: true },
  });
  return ownership?.book_guid === bookGuid;
}

/**
 * Delete every native budget owned by a book. Recurrences must be removed
 * before budgets because the native recurrence FK is restrictive; ownership
 * rows then cascade from the budget deletion.
 */
export async function deleteOwnedBudgetsForBook(
  db: OwnershipLifecycleClient,
  bookGuid: string,
): Promise<string[]> {
  const ownershipRows = await db.gnucash_web_budget_ownership.findMany({
    where: { book_guid: bookGuid },
    select: { budget_guid: true },
  });
  const budgetGuids = ownershipRows.map((row) => row.budget_guid);
  if (budgetGuids.length === 0) return [];

  await db.recurrences.deleteMany({
    where: { obj_guid: { in: budgetGuids } },
  });
  await db.budgets.deleteMany({
    where: { guid: { in: budgetGuids } },
  });

  return budgetGuids;
}
