'use client';

import { useState } from 'react';
import { useInvestmentData } from '@/contexts/InvestmentDataContext';
import { PortfolioSummaryCards } from '@/components/investments/PortfolioSummaryCards';
import { AllocationChart } from '@/components/investments/AllocationChart';
import { IndustryExposureChart } from '@/components/investments/IndustryExposureChart';
import { PerformanceChart } from '@/components/investments/PerformanceChart';
import { HoldingsTable } from '@/components/investments/HoldingsTable';
import ExpandableChart from '@/components/charts/ExpandableChart';

type AllocationTab = 'holdings' | 'cash' | 'sector';

export default function HoldingsPage() {
  const {
    portfolio, history, indices, loading, fetchingPrices,
    apiConfigured, handleFetchAllPrices
  } = useInvestmentData();

  const [allocationTab, setAllocationTab] = useState<AllocationTab>('holdings');

  // Build cash pie data from cashByAccount
  const cashPieData = portfolio?.cashByAccount?.map(a => ({
    category: a.parentName,
    value: a.cashBalance,
    percent: portfolio.overallCash.totalCashBalance > 0
      ? (a.cashBalance / portfolio.overallCash.totalCashBalance) * 100
      : 0,
  })) ?? [];

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 bg-background-tertiary rounded animate-pulse w-48" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-32 bg-background-tertiary rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!portfolio || portfolio.holdings.length === 0) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-3xl font-bold text-foreground">Investments</h1>
          <p className="text-foreground-muted mt-1">Portfolio overview and performance</p>
        </header>
        <div className="bg-background-secondary rounded-lg p-8 border border-border text-center">
          <p className="text-foreground-secondary text-lg mb-2">No investment accounts found</p>
          <p className="text-foreground-muted">
            Investment accounts (STOCK type) will appear here once you have them in GnuCash.
          </p>
        </div>
      </div>
    );
  }

  const allocationTabs: { key: AllocationTab; label: string }[] = [
    { key: 'holdings', label: 'Holdings' },
    { key: 'cash', label: 'Cash' },
    { key: 'sector', label: 'Sector' },
  ];

  const allocationTitle = allocationTab === 'holdings'
    ? 'Portfolio Allocation'
    : allocationTab === 'cash'
      ? 'Cash Allocation'
      : 'Sector Exposure';

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Investments</h1>
          <p className="text-foreground-muted mt-1">Portfolio overview and performance</p>
        </div>
        <button
          onClick={handleFetchAllPrices}
          disabled={fetchingPrices}
          className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors disabled:opacity-50"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          {fetchingPrices ? 'Fetching...' : 'Refresh All Prices'}
        </button>
      </header>

      {/* API Not Configured Warning */}
      {!apiConfigured && (
        <div className="bg-amber-900/30 border border-amber-600/50 rounded-lg p-4 flex items-center gap-3">
          <svg className="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <p className="text-amber-200 font-medium">Price API Not Configured</p>
            <p className="text-amber-300/70 text-sm">Price service is not available. Check server logs for details.</p>
          </div>
        </div>
      )}

      {/* Summary Cards */}
      <PortfolioSummaryCards {...portfolio.summary} />

      {/* Charts Row */}
      <div className="grid md:grid-cols-2 gap-6 items-stretch">
        <div className="flex flex-col gap-0">
          {/* Allocation tab selector */}
          <div className="flex gap-1 mb-2">
            {allocationTabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setAllocationTab(tab.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  allocationTab === tab.key
                    ? 'bg-cyan-600 text-white'
                    : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <ExpandableChart title={allocationTitle}>
            {allocationTab === 'holdings' ? (
              <AllocationChart data={portfolio.allocation} />
            ) : allocationTab === 'cash' ? (
              <AllocationChart data={cashPieData} />
            ) : (
              <IndustryExposureChart data={portfolio.sectorExposure} />
            )}
          </ExpandableChart>
        </div>
        <ExpandableChart title="Portfolio Performance">
          <PerformanceChart data={history} indices={indices} />
        </ExpandableChart>
      </div>

      {/* Holdings Table */}
      <HoldingsTable
        holdings={portfolio.holdings}
        consolidatedHoldings={portfolio.consolidatedHoldings}
      />
    </div>
  );
}
