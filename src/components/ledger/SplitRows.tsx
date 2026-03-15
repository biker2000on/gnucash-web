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

export default function SplitRows({ splits, currencyMnemonic }: SplitRowsProps) {
  return (
    <>
      {splits.map(split => {
        const isDebit = split.value_decimal > 0;
        const absValue = Math.abs(split.value_decimal);

        return (
          <tr key={split.guid} className="bg-background-secondary/30 border-b border-border/30">
            {/* Empty date column */}
            <td className="px-3 py-1.5" />
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
            {/* Empty balance column */}
            <td className="px-3 py-1.5" />
          </tr>
        );
      })}
    </>
  );
}
