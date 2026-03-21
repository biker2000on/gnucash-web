'use client';

import { useState, useMemo } from 'react';
import { formatCurrency } from '@/lib/format';

interface Split {
  value_decimal: number;
}

interface BalancingRowProps {
  splits: Split[];
  currencyMnemonic: string;
  transactionGuid: string;
  onAddSplit: (accountGuid: string, amount: number) => void;
}

export default function BalancingRow({
  splits,
  currencyMnemonic,
  transactionGuid,
  onAddSplit,
}: BalancingRowProps) {
  const [selectedAccountGuid, setSelectedAccountGuid] = useState('');

  const imbalance = useMemo(() => {
    return splits.reduce((sum, s) => sum + s.value_decimal, 0);
  }, [splits]);

  // If balanced, don't show the balancing row
  if (Math.abs(imbalance) < 0.001) return null;

  const balancingAmount = -imbalance;
  const isDebit = balancingAmount > 0;
  const absAmount = Math.abs(balancingAmount);

  return (
    <tr className="bg-emerald-950/20 border-b border-border/30 border-l-2 border-l-emerald-500">
      {/* Empty date */}
      <td className="px-3 py-1.5" />
      {/* Placeholder description */}
      <td className="px-3 py-1.5 pl-8 text-xs text-emerald-400 italic">
        New split...
      </td>
      {/* Account selector */}
      <td className="px-3 py-1.5">
        <input
          type="text"
          placeholder="Select account"
          value={selectedAccountGuid}
          onChange={e => setSelectedAccountGuid(e.target.value)}
          className="w-full px-2 py-0.5 bg-background-tertiary border border-border rounded text-xs text-emerald-400 focus:border-emerald-500 focus:outline-none"
        />
      </td>
      {/* Debit */}
      <td className="px-3 py-1.5 text-right text-xs text-emerald-400 font-mono">
        {isDebit ? formatCurrency(absAmount, currencyMnemonic) : ''}
      </td>
      {/* Credit */}
      <td className="px-3 py-1.5 text-right text-xs text-emerald-400 font-mono">
        {!isDebit ? formatCurrency(absAmount, currencyMnemonic) : ''}
      </td>
      {/* Empty balance */}
      <td className="px-3 py-1.5" />
    </tr>
  );
}
