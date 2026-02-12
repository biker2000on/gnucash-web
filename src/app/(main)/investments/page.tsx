'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { PortfolioSummaryCards } from '@/components/investments/PortfolioSummaryCards';
import { AllocationChart } from '@/components/investments/AllocationChart';
import { IndustryExposureChart } from '@/components/investments/IndustryExposureChart';
import { PerformanceChart } from '@/components/investments/PerformanceChart';
import { HoldingsTable } from '@/components/investments/HoldingsTable';
import { CashAllocationCard } from '@/components/investments/CashAllocationCard';
import ExpandableChart from '@/components/charts/ExpandableChart';

interface CashByAccount {
  parentGuid: string;
  parentName: string;
  parentPath: string;
  cashBalance: number;
  investmentValue: number;
  cashPercent: number;
}

interface OverallCash {
  totalCashBalance: number;
  totalInvestmentValue: number;
  totalValue: number;
  cashPercent: number;
}

interface SectorExposure {
  sector: string;
  value: number;
  percent: number;
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

interface IndexDataPoint {
  date: string;
  value: number;
  percentChange: number;
}

interface IndicesData {
  sp500: IndexDataPoint[];
  djia: IndexDataPoint[];
}

interface PortfolioData {
  summary: {
    totalValue: number;
    totalCostBasis: number;
    totalGainLoss: number;
    totalGainLossPercent: number;
    dayChange: number;
    dayChangePercent: number;
  };
  holdings: Array<{
    accountGuid: string;
    accountName: string;
    accountPath: string;
    commodityGuid: string;
    symbol: string;
    fullname: string;
    shares: number;
    costBasis: number;
    marketValue: number;
    gainLoss: number;
    gainLossPercent: number;
    latestPrice: number;
    priceDate: string;
  }>;
  allocation: Array<{
    category: string;
    value: number;
    percent: number;
  }>;
  cashByAccount: CashByAccount[];
  overallCash: OverallCash;
  sectorExposure: SectorExposure[];
  consolidatedHoldings: ConsolidatedHolding[];
}

interface HistoryData {
  history: Array<{ date: string; value: number }>;
  indices: IndicesData;
}

export default function InvestmentsPage() {
  const { success, error, warning } = useToast();

  const [portfolio, setPortfolio] = useState<PortfolioData | null>(null);
  const [history, setHistory] = useState<HistoryData['history']>([]);
  const [indices, setIndices] = useState<IndicesData>({ sp500: [], djia: [] });
  const [loading, setLoading] = useState(true);
  const [fetchingPrices, setFetchingPrices] = useState(false);
  const [apiConfigured, setApiConfigured] = useState(true);
  const [allocationTab, setAllocationTab] = useState<'account' | 'sector'>('account');

  const fetchPortfolio = useCallback(async () => {
    try {
      const res = await fetch('/api/investments/portfolio');
      const data = await res.json();
      if (res.ok) {
        setPortfolio(data);
      } else {
        error('Failed to load portfolio data');
      }
    } catch {
      error('Failed to load portfolio data');
    } finally {
      setLoading(false);
    }
  }, [error]);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/investments/history?days=36500');
      const data = await res.json();
      if (res.ok) {
        setHistory(data.history || []);
        if (data.indices) {
          setIndices(data.indices);
        }
      }
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  }, []);

  useEffect(() => {
    fetchPortfolio();
    fetchHistory();
  }, [fetchPortfolio, fetchHistory]);

  useEffect(() => {
    fetch('/api/investments/status')
      .then(res => res.json())
      .then(data => setApiConfigured(data.configured))
      .catch(() => {});
  }, []);

  const handleFetchAllPrices = async () => {
    setFetchingPrices(true);
    try {
      const res = await fetch('/api/prices/fetch', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        error(data.error || 'Failed to fetch prices');
        return;
      }

      if (data.stored > 0) {
        success(
          `Updated: ${data.backfilled} historical prices backfilled, ${data.gapsFilled} gap prices filled (${data.stored} total)`
        );
        fetchPortfolio();
        fetchHistory();
      } else if (data.failed > 0) {
        warning(`Failed to fetch ${data.failed} prices`);
      } else {
        success('All historical prices are up to date');
      }
    } catch {
      error('Network error fetching prices');
    } finally {
      setFetchingPrices(false);
    }
  };

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

  if (!loading && (!portfolio || portfolio.holdings.length === 0)) {
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
      {portfolio && <PortfolioSummaryCards {...portfolio.summary} />}

      {/* Cash Allocation */}
      {portfolio && portfolio.cashByAccount && portfolio.cashByAccount.length > 0 && (
        <CashAllocationCard
          cashByAccount={portfolio.cashByAccount}
          overallCash={portfolio.overallCash}
        />
      )}

      {/* Charts Row */}
      <div className="grid md:grid-cols-2 gap-6 items-stretch">
        {portfolio && (
          <div className="flex flex-col gap-0">
            {/* Allocation tab selector */}
            <div className="flex gap-1 mb-2">
              <button
                onClick={() => setAllocationTab('account')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  allocationTab === 'account'
                    ? 'bg-cyan-600 text-white'
                    : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                }`}
              >
                By Account
              </button>
              <button
                onClick={() => setAllocationTab('sector')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  allocationTab === 'sector'
                    ? 'bg-cyan-600 text-white'
                    : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                }`}
              >
                By Sector
              </button>
            </div>
            <ExpandableChart title={allocationTab === 'account' ? 'Portfolio Allocation' : 'Sector Exposure'}>
              {allocationTab === 'account' ? (
                <AllocationChart data={portfolio.allocation} />
              ) : (
                <IndustryExposureChart data={portfolio.sectorExposure} />
              )}
            </ExpandableChart>
          </div>
        )}
        <ExpandableChart title="Portfolio Performance">
          <PerformanceChart data={history} indices={indices} />
        </ExpandableChart>
      </div>

      {/* Holdings Table */}
      {portfolio && (
        <HoldingsTable
          holdings={portfolio.holdings}
          consolidatedHoldings={portfolio.consolidatedHoldings}
        />
      )}
    </div>
  );
}
