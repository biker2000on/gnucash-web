export interface ReconciliationRowSplit {
  guid: string;
  reconcile_state: string;
  amount: string;
}

export interface ReconciliationRow {
  account_split_guid: string;
  account_split_reconcile_state: string;
  account_split_value: string;
  account_splits?: ReconciliationRowSplit[];
}

/** Normalize legacy single-split rows and current multi-split rows. */
export function getRowAccountSplits(row: ReconciliationRow): ReconciliationRowSplit[] {
  if (row.account_splits?.length) return row.account_splits;
  if (!row.account_split_guid) return [];
  return [{
    guid: row.account_split_guid,
    reconcile_state: row.account_split_reconcile_state,
    amount: row.account_split_value,
  }];
}

export function getSelectableRowSplits(row: ReconciliationRow): ReconciliationRowSplit[] {
  return getRowAccountSplits(row).filter((split) => split.reconcile_state !== 'y');
}

export function isRowSelected(row: ReconciliationRow, selected: Set<string>): boolean {
  const selectable = getSelectableRowSplits(row);
  return selectable.length > 0 && selectable.every((split) => selected.has(split.guid));
}

export function toggleRowSelection(row: ReconciliationRow, selected: Set<string>): Set<string> {
  const next = new Set(selected);
  const selectable = getSelectableRowSplits(row);
  const remove = selectable.length > 0 && selectable.every((split) => next.has(split.guid));
  for (const split of selectable) {
    if (remove) next.delete(split.guid);
    else next.add(split.guid);
  }
  return next;
}

export function selectAllRows(rows: ReconciliationRow[]): Set<string> {
  return new Set(
    rows.flatMap((row) => getSelectableRowSplits(row).map((split) => split.guid)),
  );
}

export function sumSelectedRows(rows: ReconciliationRow[], selected: Set<string>): number {
  return rows.reduce(
    (sum, row) => sum + getRowAccountSplits(row).reduce(
      (rowSum, split) => rowSum + (selected.has(split.guid) ? Number(split.amount) || 0 : 0),
      0,
    ),
    0,
  );
}
