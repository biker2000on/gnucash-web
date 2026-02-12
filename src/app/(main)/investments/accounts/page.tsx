'use client';

import { useState, useMemo, useEffect } from 'react';
import { useInvestmentData } from '@/contexts/InvestmentDataContext';
import { AllocationChart } from '@/components/investments/AllocationChart';
import { PerformanceChart } from '@/components/investments/PerformanceChart';
import { HoldingsTable } from '@/components/investments/HoldingsTable';
import { PortfolioSummaryCards } from '@/components/investments/PortfolioSummaryCards';
import ExpandableChart from '@/components/charts/ExpandableChart';

export default function AccountsPage() {
  const { portfolio, indices, loading, fetchAccountHistory, getAccountHistory } = useInvestmentData();
  const [selectedAccount, setSelectedAccount] = useState<string>('');

  // Build unique parent accounts list from holdings
  const parentAccounts = useMemo(() => {
    if (!portfolio) return [];
    const parents = new Map<string, string>();
    portfolio.holdings.forEach(h => {
      const parts = h.accountPath.split(':');
      const parentName = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      if (!parents.has(parentName)) {
        parents.set(parentName, parentName);
      }
    });
    return Array.from(parents.keys()).map(name => ({ key: name, name }));
  }, [portfolio]);

  // Auto-select first account on load
  useEffect(() => {
    if (parentAccounts.length > 0 && !selectedAccount) {
      setSelectedAccount(parentAccounts[0].key);
    }
  }, [parentAccounts, selectedAccount]);

  // Filter holdings for selected account
  const filteredHoldings = useMemo(() => {
    if (!portfolio || !selectedAccount) return [];
    return portfolio.holdings.filter(h => {
      const parts = h.accountPath.split(':');
      const parentName = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      return parentName === selectedAccount;
    });
  }, [portfolio, selectedAccount]);

  // Calculate filtered summary
  const filteredSummary = useMemo(() => {
    if (filteredHoldings.length === 0) {
      return {
        totalValue: 0,
        totalCostBasis: 0,
        totalGainLoss: 0,
        totalGainLossPercent: 0,
        dayChange: 0,
        dayChangePercent: 0,
      };
    }
    const totalValue = filteredHoldings.reduce((sum, h) => sum + h.marketValue, 0);
    const totalCostBasis = filteredHoldings.reduce((sum, h) => sum + h.costBasis, 0);
    const totalGainLoss = totalValue - totalCostBasis;
    const totalGainLossPercent = totalCostBasis > 0
      ? ((totalGainLoss / totalCostBasis) * 100)
      : 0;
    return {
      totalValue,
      totalCostBasis,
      totalGainLoss,
      totalGainLossPercent,
      dayChange: 0,
      dayChangePercent: 0,
    };
  }, [filteredHoldings]);

  // Build allocation from filtered holdings
  const filteredAllocation = useMemo(() => {
    if (filteredHoldings.length === 0) return [];
    const totalValue = filteredHoldings.reduce((sum, h) => sum + h.marketValue, 0);
    return filteredHoldings.map(h => ({
      category: h.symbol,
      value: h.marketValue,
      percent: totalValue > 0 ? (h.marketValue / totalValue) * 100 : 0,
    }));
  }, [filteredHoldings]);

  // Get account GUIDs for selected parent account
  const filteredAccountGuids = useMemo(() => {
    return filteredHoldings.map(h => h.accountGuid);
  }, [filteredHoldings]);

  // Trigger fetch when account selection changes
  useEffect(() => {
    if (filteredAccountGuids.length > 0) {
      fetchAccountHistory(filteredAccountGuids);
    }
  }, [filteredAccountGuids, fetchAccountHistory]);

  // Get the cached account history
  const accountHistory = getAccountHistory(filteredAccountGuids);

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
          <h1 className="text-3xl font-bold text-foreground">Account View</h1>
          <p className="text-foreground-muted mt-1">Per-account investment breakdown</p>
        </header>
        <div className="bg-background-secondary rounded-lg p-8 border border-border text-center">
          <p className="text-foreground-secondary text-lg mb-2">No investment accounts found</p>
          <p className="text-foreground-muted">
            Investment accounts will appear here once you have them in GnuCash.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Account View</h1>
          <p className="text-foreground-muted mt-1">Per-account investment breakdown</p>
        </div>
        <select
          value={selectedAccount}
          onChange={(e) => setSelectedAccount(e.target.value)}
          className="px-4 py-2 bg-background-secondary border border-border rounded-lg text-foreground"
        >
          {parentAccounts.map(a => (
            <option key={a.key} value={a.key}>{a.name}</option>
          ))}
        </select>
      </header>

      {/* Filtered summary cards */}
      <PortfolioSummaryCards {...filteredSummary} />

      {/* Charts */}
      <div className="grid md:grid-cols-2 gap-6 items-stretch">
        <ExpandableChart title="Account Allocation">
          <AllocationChart data={filteredAllocation} />
        </ExpandableChart>
        <ExpandableChart title="Account Performance">
          <PerformanceChart data={accountHistory} indices={indices} />
        </ExpandableChart>
      </div>

      {/* Filtered holdings table */}
      <HoldingsTable holdings={filteredHoldings} />
    </div>
  );
}
