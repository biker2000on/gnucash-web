'use client';

import { formatCurrency } from '@/lib/format';

interface SplitDisplay {
  guid: string;
  account_name: string;
  account_fullname: string;
  memo: string;
  value_decimal: number;
  quantity_decimal: number;
  account_guid: string;
}

interface SplitRowsProps {
  splits: SplitDisplay[];
  currencyMnemonic: string;
  columns: number;
}

// IMPORTANT: Pass ALL splits including the account's own split.
// Do NOT filter out splits where account_guid === current account.

export default function SplitRows({ splits, currencyMnemonic, columns }: SplitRowsProps) {
  // Table layout: [select?] [expand?] [reconcile] [date] [description] [transfer] [debit] [credit] [balance] [actions?]
  // Split rows need: empty cells up to and including date, then memo, account, debit, credit, empty balance, [empty actions?]
  // Fixed columns from the right: balance(1) + credit(1) + debit(1) + transfer(1) + description(1) = 5
  // Plus optional actions column. Leading empty cols = columns - 5 (description, transfer, debit, credit, balance) - trailing
  // Simpler: we know the last 5 standard cols are description, transfer, debit, credit, balance.
  // Leading columns (before description) = columns - 5 - (actions cols)
  // But we don't know about actions here. Instead, calculate:
  // leadingEmpty = all columns before "description" (reconcile, date, and optionally select/expand)
  // trailingEmpty = balance column + optional actions
  // middle = description(memo) + transfer(account) + debit + credit = 4
  // leadingEmpty + 4 + trailingEmpty = columns
  // trailingEmpty >= 1 (at least balance)
  // leadingEmpty = columns - 4 - trailingEmpty
  // We know trailing is either 1 (balance) or 2 (balance + actions)
  // Safest: leadingEmpty = columns - 5, trailingEmpty = 1 ... but if actions present, leadingEmpty = columns - 6, trailingEmpty = 2
  // Actually simplest approach: render leading empties = columns - 5, then 4 content cells, then 1 trailing empty
  // If actions column exists, that's columns - 6 leading, 4 content, 2 trailing
  // But we can just do: leadingEmpty cells + content + fill remaining with empty
  const contentCols = 4; // memo, account, debit, credit
  const trailingEmpty = 1; // at least balance
  const leadingEmpty = Math.max(0, columns - contentCols - trailingEmpty);
  const actualTrailing = columns - leadingEmpty - contentCols;

  return (
    <>
      {splits.map(split => {
        const isDebit = split.value_decimal > 0;
        const absValue = Math.abs(split.value_decimal);

        return (
          <tr key={split.guid} className="bg-background-secondary/30 border-b border-border/30">
            {/* Empty leading columns (select, expand, reconcile, date, etc.) */}
            {Array.from({ length: leadingEmpty }, (_, i) => (
              <td key={`lead-${i}`} className="px-3 py-1.5" />
            ))}
            {/* Memo in description column */}
            <td className="px-3 py-1.5 pl-8 text-xs text-foreground-muted">
              {split.memo || ''}
            </td>
            {/* Account path in transfer column */}
            <td className="px-3 py-1.5 text-xs text-cyan-400">
              {split.account_fullname || split.account_name}
            </td>
            {/* Debit */}
            <td className="px-3 py-1.5 text-right text-xs text-foreground-secondary font-mono">
              {isDebit ? formatCurrency(absValue, currencyMnemonic) : ''}
            </td>
            {/* Credit */}
            <td className="px-3 py-1.5 text-right text-xs text-foreground-secondary font-mono">
              {!isDebit && absValue > 0 ? formatCurrency(absValue, currencyMnemonic) : ''}
            </td>
            {/* Empty trailing columns (balance, actions, etc.) */}
            {Array.from({ length: actualTrailing }, (_, i) => (
              <td key={`trail-${i}`} className="px-3 py-1.5" />
            ))}
          </tr>
        );
      })}
    </>
  );
}
