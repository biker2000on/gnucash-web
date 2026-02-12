'use client';

import { useState } from 'react';
import { useInvestmentData } from '@/contexts/InvestmentDataContext';
import { CashAllocationCard } from '@/components/investments/CashAllocationCard';

type SortMode = 'percent' | 'amount';

export default function CashDetailsPage() {
  const { portfolio, loading } = useInvestmentData();
  const [sortMode, setSortMode] = useState<SortMode>('percent');

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 bg-background-tertiary rounded animate-pulse w-48" />
        <div className="h-64 bg-background-tertiary rounded-lg animate-pulse" />
      </div>
    );
  }

  if (!portfolio || !portfolio.cashByAccount || portfolio.cashByAccount.length === 0) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-3xl font-bold text-foreground">Cash Details</h1>
          <p className="text-foreground-muted mt-1">Cash allocation across investment accounts</p>
        </header>
        <div className="bg-background-secondary rounded-lg p-8 border border-border text-center">
          <p className="text-foreground-secondary text-lg mb-2">No cash data available</p>
          <p className="text-foreground-muted">
            Cash balances will appear here once detected in your investment accounts.
          </p>
        </div>
      </div>
    );
  }

  const sortedCash = [...portfolio.cashByAccount].sort((a, b) =>
    sortMode === 'percent'
      ? b.cashPercent - a.cashPercent
      : b.cashBalance - a.cashBalance
  );

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Cash Details</h1>
          <p className="text-foreground-muted mt-1">Cash allocation across investment accounts</p>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => setSortMode('percent')}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              sortMode === 'percent'
                ? 'bg-cyan-600 text-white'
                : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
            }`}
          >
            Sort by %
          </button>
          <button
            onClick={() => setSortMode('amount')}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              sortMode === 'amount'
                ? 'bg-cyan-600 text-white'
                : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
            }`}
          >
            Sort by $
          </button>
        </div>
      </header>

      <CashAllocationCard
        cashByAccount={sortedCash}
        overallCash={portfolio.overallCash}
      />
    </div>
  );
}
