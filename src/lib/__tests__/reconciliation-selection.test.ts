import { describe, expect, it } from 'vitest';
import {
  getSelectableRowSplits,
  isRowSelected,
  selectAllRows,
  sumSelectedRows,
  toggleRowSelection,
  type ReconciliationRow,
} from '@/lib/reconciliation-selection';

function row(overrides: Partial<ReconciliationRow> = {}): ReconciliationRow {
  return {
    account_split_guid: 'legacy',
    account_split_reconcile_state: 'n',
    account_split_value: '10.00',
    ...overrides,
  };
}

describe('reconciliation row selection', () => {
  it('keeps the legacy single-split contract working', () => {
    const legacy = row();
    expect(getSelectableRowSplits(legacy)).toHaveLength(1);
    expect(sumSelectedRows([legacy], new Set(['legacy']))).toBe(10);
  });

  it('selects and totals every unreconciled same-account split in a row', () => {
    const multi = row({
      account_splits: [
        { guid: 'a', reconcile_state: 'n', amount: '25.50' },
        { guid: 'b', reconcile_state: 'c', amount: '-5.25' },
        { guid: 'done', reconcile_state: 'y', amount: '100.00' },
      ],
    });

    const selected = toggleRowSelection(multi, new Set());
    expect([...selected].sort()).toEqual(['a', 'b']);
    expect(isRowSelected(multi, selected)).toBe(true);
    expect(sumSelectedRows([multi], selected)).toBe(20.25);
    expect(toggleRowSelection(multi, selected).size).toBe(0);
  });

  it('select-all includes every eligible split without already-reconciled splits', () => {
    const selected = selectAllRows([
      row({
        account_splits: [
          { guid: 'a', reconcile_state: 'n', amount: '10' },
          { guid: 'b', reconcile_state: 'y', amount: '20' },
        ],
      }),
      row({ account_split_guid: 'c', account_split_value: '-3.50' }),
    ]);
    expect([...selected].sort()).toEqual(['a', 'c']);
  });
});
