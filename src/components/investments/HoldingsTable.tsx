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
  const [showZeroShares, setShowZeroShares] = useState(false);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  // Filter out zero-share holdings if toggle is off
  const filteredHoldings = showZeroShares
    ? holdings
    : holdings.filter(h => h.shares !== 0);

  const sortedHoldings = [...filteredHoldings].sort((a, b) => {
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    const mult = sortDir === 'asc' ? 1 : -1;
    if (typeof aVal === 'string') return aVal.localeCompare(bVal as string) * mult;
    return ((aVal as number) - (bVal as number)) * mult;
  });

  const SortHeader = ({ label, sortKeyName }: { label: string; sortKeyName: SortKey }) => (
    <th
      onClick={() => handleSort(sortKeyName)}
      className="px-4 py-3 text-left text-sm font-medium text-foreground-secondary cursor-pointer hover:text-foreground"
    >
      {label} {sortKey === sortKeyName && (sortDir === 'asc' ? '↑' : '↓')}
    </th>
  );

  if (!holdings || holdings.length === 0) {
    return (
      <div className="bg-background-secondary rounded-lg p-6 border border-border">
        <h3 className="text-lg font-semibold text-foreground mb-4">Holdings</h3>
        <p className="text-foreground-muted">No holdings found</p>
      </div>
    );
  }

  return (
    <div className="bg-background-secondary rounded-lg border border-border overflow-hidden">
      <div className="p-4 border-b border-border flex items-center justify-between">
        <h3 className="text-lg font-semibold text-foreground">Holdings</h3>
        <button
          onClick={() => setShowZeroShares(!showZeroShares)}
          className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
            showZeroShares
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-background-tertiary text-foreground-secondary hover:bg-background-tertiary/80'
          }`}
        >
          {showZeroShares ? 'Hide' : 'Show'} Closed Positions
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-background-tertiary/50">
            <tr>
              <SortHeader label="Symbol" sortKeyName="symbol" />
              <SortHeader label="Shares" sortKeyName="shares" />
              <SortHeader label="Cost Basis" sortKeyName="costBasis" />
              <SortHeader label="Market Value" sortKeyName="marketValue" />
              <SortHeader label="Gain/Loss" sortKeyName="gainLoss" />
              <SortHeader label="Gain %" sortKeyName="gainLossPercent" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sortedHoldings.map((holding) => (
              <tr
                key={holding.accountGuid}
                onClick={() => router.push(`/accounts/${holding.accountGuid}`)}
                className="hover:bg-surface-hover/50 cursor-pointer transition-colors"
              >
                <td className="px-4 py-3">
                  <div className="font-medium text-foreground" title={holding.accountPath}>{holding.symbol}</div>
                  <div className="text-sm text-foreground-muted">{holding.accountName}</div>
                </td>
                <td className="px-4 py-3 text-foreground-secondary">{holding.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                <td className="px-4 py-3 text-foreground-secondary">{formatCurrency(holding.costBasis)}</td>
                <td className="px-4 py-3 text-foreground-secondary">{formatCurrency(holding.marketValue)}</td>
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
