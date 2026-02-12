'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useToast } from '@/contexts/ToastContext';
import type { PortfolioData, IndicesData, HistoryData } from '@/types/investments';

interface InvestmentDataContextType {
  portfolio: PortfolioData | null;
  history: HistoryData['history'];
  indices: IndicesData;
  loading: boolean;
  apiConfigured: boolean;
  fetchingPrices: boolean;
  fetchPortfolio: () => Promise<void>;
  fetchHistory: () => Promise<void>;
  handleFetchAllPrices: () => Promise<void>;
}

const InvestmentDataContext = createContext<InvestmentDataContextType | null>(null);

export function InvestmentDataProvider({ children }: { children: ReactNode }) {
  const { success, error, warning } = useToast();

  const [portfolio, setPortfolio] = useState<PortfolioData | null>(null);
  const [history, setHistory] = useState<HistoryData['history']>([]);
  const [indices, setIndices] = useState<IndicesData>({ sp500: [], djia: [] });
  const [loading, setLoading] = useState(true);
  const [fetchingPrices, setFetchingPrices] = useState(false);
  const [apiConfigured, setApiConfigured] = useState(true);

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
        indices,
        loading,
        apiConfigured,
        fetchingPrices,
        fetchPortfolio,
        fetchHistory,
        handleFetchAllPrices,
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
