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

interface ConsolidatedHolding {
  commodityGuid: string;
  symbol: string;
  fullname: string;
  totalShares: number;
  totalCostBasis: number;
  totalMarketValue: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  latestPrice: number;
  priceDate: string;
  accounts: Array<{
    accountGuid: string;
    accountName: string;
    accountPath: string;
    shares: number;
    costBasis: number;
    marketValue: number;
    gainLoss: number;
    gainLossPercent: number;
  }>;
}

interface HoldingsTableProps {
  holdings: Holding[];
  consolidatedHoldings?: ConsolidatedHolding[];
}

type SortKey = 'symbol' | 'shares' | 'costBasis' | 'marketValue' | 'gainLoss' | 'gainLossPercent';
type SortDir = 'asc' | 'desc';

function SortHeader({ label, sortKeyName, sortKey, sortDir, onSort }: {
  label: string;
  sortKeyName: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  return (
    <th
      onClick={() => onSort(sortKeyName)}
      className="px-4 py-3 text-left text-sm font-medium text-foreground-secondary cursor-pointer hover:text-foreground"
    >
      {label} {sortKey === sortKeyName && (sortDir === 'asc' ? '\u2191' : '\u2193')}
    </th>
  );
}

export function HoldingsTable({ holdings, consolidatedHoldings }: HoldingsTableProps) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>('marketValue');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [showZeroShares, setShowZeroShares] = useState(false);
  const [expandedCommodities, setExpandedCommodities] = useState<Set<string>>(new Set());

  const useConsolidated = !!consolidatedHoldings && consolidatedHoldings.length > 0;

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const toggleExpanded = (commodityGuid: string) => {
    setExpandedCommodities(prev => {
      const next = new Set(prev);
      if (next.has(commodityGuid)) {
        next.delete(commodityGuid);
      } else {
        next.add(commodityGuid);
      }
      return next;
    });
  };

  // Map sort keys to consolidated holding fields
  const consolidatedSortKeyMap: Record<SortKey, keyof ConsolidatedHolding> = {
    symbol: 'symbol',
    shares: 'totalShares',
    costBasis: 'totalCostBasis',
    marketValue: 'totalMarketValue',
    gainLoss: 'totalGainLoss',
    gainLossPercent: 'totalGainLossPercent',
  };

  if (!holdings || holdings.length === 0) {
    return (
      <div className="bg-background-secondary rounded-lg p-6 border border-border">
        <h3 className="text-lg font-semibold text-foreground mb-4">Holdings</h3>
        <p className="text-foreground-muted">No holdings found</p>
      </div>
    );
  }

  // Consolidated view
  if (useConsolidated) {
    const filtered = showZeroShares
      ? consolidatedHoldings
      : consolidatedHoldings.filter(h => h.totalShares !== 0);

    const sorted = [...filtered].sort((a, b) => {
      const aKey = consolidatedSortKeyMap[sortKey];
      const bKey = consolidatedSortKeyMap[sortKey];
      const aVal = a[aKey];
      const bVal = b[bKey];
      const mult = sortDir === 'asc' ? 1 : -1;
      if (typeof aVal === 'string') return (aVal as string).localeCompare(bVal as string) * mult;
      return ((aVal as number) - (bVal as number)) * mult;
    });

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
                <th className="w-8 px-2 py-3"></th>
                <SortHeader label="Symbol" sortKeyName="symbol" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Shares" sortKeyName="shares" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Cost Basis" sortKeyName="costBasis" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Market Value" sortKeyName="marketValue" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Gain/Loss" sortKeyName="gainLoss" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Gain %" sortKeyName="gainLossPercent" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((holding) => {
                const isMultiAccount = holding.accounts.length > 1;
                const isExpanded = expandedCommodities.has(holding.commodityGuid);

                return (
                  <ConsolidatedRow
                    key={holding.commodityGuid}
                    holding={holding}
                    isMultiAccount={isMultiAccount}
                    isExpanded={isExpanded}
                    onToggle={() => toggleExpanded(holding.commodityGuid)}
                    onNavigate={(guid) => router.push(`/accounts/${guid}`)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Fallback: legacy flat view
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
              <SortHeader label="Symbol" sortKeyName="symbol" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="Shares" sortKeyName="shares" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="Cost Basis" sortKeyName="costBasis" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="Market Value" sortKeyName="marketValue" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="Gain/Loss" sortKeyName="gainLoss" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="Gain %" sortKeyName="gainLossPercent" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
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

/**
 * Renders a consolidated row with optional expandable sub-rows
 */
function ConsolidatedRow({
  holding,
  isMultiAccount,
  isExpanded,
  onToggle,
  onNavigate,
}: {
  holding: ConsolidatedHolding;
  isMultiAccount: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onNavigate: (guid: string) => void;
}) {
  return (
    <>
      {/* Main consolidated row */}
      <tr
        onClick={isMultiAccount ? onToggle : () => onNavigate(holding.accounts[0].accountGuid)}
        className="hover:bg-surface-hover/50 cursor-pointer transition-colors"
      >
        <td className="px-2 py-3 text-center">
          {isMultiAccount && (
            <svg
              className={`w-4 h-4 text-foreground-secondary transition-transform ${isExpanded ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          )}
        </td>
        <td className="px-4 py-3">
          <div className="font-medium text-foreground">{holding.symbol}</div>
          <div className="text-sm text-foreground-muted">{holding.fullname}</div>
        </td>
        <td className="px-4 py-3 text-foreground-secondary">
          {holding.totalShares.toLocaleString(undefined, { maximumFractionDigits: 4 })}
        </td>
        <td className="px-4 py-3 text-foreground-secondary">{formatCurrency(holding.totalCostBasis)}</td>
        <td className="px-4 py-3 text-foreground-secondary">{formatCurrency(holding.totalMarketValue)}</td>
        <td className={`px-4 py-3 ${holding.totalGainLoss >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {formatCurrency(holding.totalGainLoss)}
        </td>
        <td className={`px-4 py-3 ${holding.totalGainLossPercent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {holding.totalGainLossPercent >= 0 ? '+' : ''}{holding.totalGainLossPercent.toFixed(2)}%
        </td>
      </tr>

      {/* Expanded sub-rows */}
      {isMultiAccount && isExpanded && holding.accounts.map((account) => (
        <tr
          key={account.accountGuid}
          onClick={() => onNavigate(account.accountGuid)}
          className="hover:bg-surface-hover/30 cursor-pointer transition-colors bg-background-tertiary/20"
        >
          <td className="px-2 py-2"></td>
          <td className="px-4 py-2 pl-8">
            <div className="text-sm text-foreground-secondary">{account.accountPath}</div>
          </td>
          <td className="px-4 py-2 text-sm text-foreground-muted">
            {account.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}
          </td>
          <td className="px-4 py-2 text-sm text-foreground-muted">{formatCurrency(account.costBasis)}</td>
          <td className="px-4 py-2 text-sm text-foreground-muted">{formatCurrency(account.marketValue)}</td>
          <td className={`px-4 py-2 text-sm ${account.gainLoss >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
            {formatCurrency(account.gainLoss)}
          </td>
          <td className={`px-4 py-2 text-sm ${account.gainLossPercent >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
            {account.gainLossPercent >= 0 ? '+' : ''}{account.gainLossPercent.toFixed(2)}%
          </td>
        </tr>
      ))}
    </>
  );
}
