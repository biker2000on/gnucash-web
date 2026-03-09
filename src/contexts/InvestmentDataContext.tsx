'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useToast } from '@/contexts/ToastContext';
import type { PortfolioData, IndicesData, HistoryData, CashFlowPoint, HistoryPoint } from '@/types/investments';

interface InvestmentDataContextType {
  portfolio: PortfolioData | null;
  history: HistoryPoint[];
  portfolioCashFlows: CashFlowPoint[];
  indices: IndicesData;
  loading: boolean;
  apiConfigured: boolean;
  fetchingPrices: boolean;
  fetchPortfolio: () => Promise<void>;
  fetchHistory: () => Promise<void>;
  handleFetchAllPrices: () => Promise<void>;
  fetchAccountHistory: (accountGuids: string[]) => Promise<void>;
  getAccountHistory: (accountGuids: string[]) => HistoryPoint[];
  getAccountCashFlows: (accountGuids: string[]) => CashFlowPoint[];
}

const InvestmentDataContext = createContext<InvestmentDataContextType | null>(null);

export function InvestmentDataProvider({ children }: { children: ReactNode }) {
  const { success, error, warning } = useToast();

  const [portfolio, setPortfolio] = useState<PortfolioData | null>(null);
  const [history, setHistory] = useState<HistoryData['history']>([]);
  const [portfolioCashFlows, setPortfolioCashFlows] = useState<CashFlowPoint[]>([]);
  const [indices, setIndices] = useState<IndicesData>({ sp500: [], djia: [], nasdaq: [], russell2000: [] });
  const [loading, setLoading] = useState(true);
  const [fetchingPrices, setFetchingPrices] = useState(false);
  const [apiConfigured, setApiConfigured] = useState(true);
  const [accountHistoryMap, setAccountHistoryMap] = useState<Record<string, { history: HistoryPoint[]; cashFlows: CashFlowPoint[] }>>({});

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
        setPortfolioCashFlows(data.cashFlows || []);
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

  const fetchAccountHistory = useCallback(async (accountGuids: string[]) => {
    const key = [...accountGuids].sort().join(',');
    // Skip if already cached
    if (accountHistoryMap[key]) return;

    try {
      const res = await fetch(`/api/investments/history?days=36500&accountGuids=${accountGuids.join(',')}`);
      const data = await res.json();
      if (res.ok) {
        setAccountHistoryMap(prev => ({
          ...prev,
          [key]: {
            history: data.history || [],
            cashFlows: data.cashFlows || [],
          },
        }));
      }
    } catch (err) {
      console.error('Failed to load account history:', err);
    }
  }, [accountHistoryMap]);

  const getAccountHistory = useCallback((accountGuids: string[]) => {
    const key = [...accountGuids].sort().join(',');
    return accountHistoryMap[key]?.history || [];
  }, [accountHistoryMap]);

  const getAccountCashFlows = useCallback((accountGuids: string[]) => {
    const key = [...accountGuids].sort().join(',');
    return accountHistoryMap[key]?.cashFlows || [];
  }, [accountHistoryMap]);

  const handleFetchAllPrices = useCallback(async () => {
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
  }, [error, success, warning, fetchPortfolio, fetchHistory]);

  return (
    <InvestmentDataContext.Provider
      value={{
        portfolio,
        history,
        portfolioCashFlows,
        indices,
        loading,
        apiConfigured,
        fetchingPrices,
        fetchPortfolio,
        fetchHistory,
        handleFetchAllPrices,
        fetchAccountHistory,
        getAccountHistory,
        getAccountCashFlows,
      }}
    >
      {children}
    </InvestmentDataContext.Provider>
  );
}

export function useInvestmentData() {
  const ctx = useContext(InvestmentDataContext);
  if (!ctx) {
    throw new Error('useInvestmentData must be used within InvestmentDataProvider');
  }
  return ctx;
}
