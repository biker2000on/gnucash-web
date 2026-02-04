'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatCurrency } from '@/lib/format';

interface Holding {
  accountGuid: string;
  accountName: string;
  accountPath?: string;
  symbol: string;
  shares: number;
  costBasis: number;
  marketValue: number;
  gainLoss: number;
  gainLossPercent: number;
}

interface HoldingsTableProps {
  holdings: Holding[];
}

type SortKey = 'symbol' | 'shares' | 'costBasis' | 'marketValue' | 'gainLoss' | 'gainLossPercent';
type SortDir = 'asc' | 'desc';

export function HoldingsTable({ holdings }: HoldingsTableProps) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>('marketValue');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortedHoldings = [...holdings].sort((a, b) => {
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    const mult = sortDir === 'asc' ? 1 : -1;
    if (typeof aVal === 'string') return aVal.localeCompare(bVal as string) * mult;
    return ((aVal as number) - (bVal as number)) * mult;
  });

  const SortHeader = ({ label, sortKeyName }: { label: string; sortKeyName: SortKey }) => (
    <th
      onClick={() => handleSort(sortKeyName)}
      className="px-4 py-3 text-left text-sm font-medium text-neutral-400 cursor-pointer hover:text-neutral-200"
    >
      {label} {sortKey === sortKeyName && (sortDir === 'asc' ? '↑' : '↓')}
    </th>
  );

  if (!holdings || holdings.length === 0) {
    return (
      <div className="bg-neutral-900 rounded-lg p-6 border border-neutral-800">
        <h3 className="text-lg font-semibold text-neutral-100 mb-4">Holdings</h3>
        <p className="text-neutral-500">No holdings found</p>
      </div>
    );
  }

  return (
    <div className="bg-neutral-900 rounded-lg border border-neutral-800 overflow-hidden">
      <div className="p-4 border-b border-neutral-800">
        <h3 className="text-lg font-semibold text-neutral-100">Holdings</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-neutral-800/50">
            <tr>
              <SortHeader label="Symbol" sortKeyName="symbol" />
              <SortHeader label="Shares" sortKeyName="shares" />
              <SortHeader label="Cost Basis" sortKeyName="costBasis" />
              <SortHeader label="Market Value" sortKeyName="marketValue" />
              <SortHeader label="Gain/Loss" sortKeyName="gainLoss" />
              <SortHeader label="Gain %" sortKeyName="gainLossPercent" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {sortedHoldings.map((holding) => (
              <tr
                key={holding.accountGuid}
                onClick={() => router.push(`/accounts/${holding.accountGuid}`)}
                className="hover:bg-neutral-800/50 cursor-pointer transition-colors"
              >
                <td className="px-4 py-3">
                  <div className="font-medium text-neutral-100" title={holding.accountPath}>{holding.symbol}</div>
                  <div className="text-sm text-neutral-500">{holding.accountName}</div>
                </td>
                <td className="px-4 py-3 text-neutral-300">{holding.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                <td className="px-4 py-3 text-neutral-300">{formatCurrency(holding.costBasis)}</td>
                <td className="px-4 py-3 text-neutral-300">{formatCurrency(holding.marketValue)}</td>
                <td className={`px-4 py-3 ${holding.gainLoss >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {formatCurrency(holding.gainLoss)}
                </td>
                <td className={`px-4 py-3 ${holding.gainLossPercent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {holding.gainLossPercent >= 0 ? '+' : ''}{holding.gainLossPercent.toFixed(2)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
