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
  commodity_mnemonic?: string;
}

interface SplitRowsProps {
  splits: SplitDisplay[];
  currencyMnemonic: string;
  columns: number;
  /** Number of trailing columns after the debit/credit content (balance, shareBalance, costBasis, actions, etc.) */
  trailingColumns?: number;
}

// IMPORTANT: Pass ALL splits including the account's own split.
// Do NOT filter out splits where account_guid === current account.

export default function SplitRows({ splits, currencyMnemonic, columns, trailingColumns }: SplitRowsProps) {
  // Split rows render 4 content cells: memo (description col), account (transfer col), debit, credit.
  // Leading empty cells fill columns before description (select, expand, reconcile, date, etc.).
  // Trailing empty cells fill columns after credit (balance, shareBalance, costBasis, actions, etc.).
  //
  // For standard accounts: trailing = 1 (balance) or 2 (balance + actions)
  // For investment accounts: trailing = 3+ (shareBalance, costBasis, [actions])
  //
  // The caller can override with trailingColumns prop for correct alignment.
  const contentCols = 4; // memo, account, debit, credit
  const trailingEmpty = trailingColumns ?? 1;
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
              {isDebit ? formatCurrency(absValue, split.commodity_mnemonic || currencyMnemonic) : ''}
            </td>
            {/* Credit */}
            <td className="px-3 py-1.5 text-right text-xs text-foreground-secondary font-mono">
              {!isDebit && absValue > 0 ? formatCurrency(absValue, split.commodity_mnemonic || currencyMnemonic) : ''}
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
