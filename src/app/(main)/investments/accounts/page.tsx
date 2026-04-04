'use client';

import { useState, useMemo, useEffect } from 'react';
import { useInvestmentData } from '@/contexts/InvestmentDataContext';
import { AllocationChart } from '@/components/investments/AllocationChart';
import { IndustryExposureChart } from '@/components/investments/IndustryExposureChart';
import { PerformanceChart } from '@/components/investments/PerformanceChart';
import { HoldingsTable } from '@/components/investments/HoldingsTable';
import { PortfolioSummaryCards } from '@/components/investments/PortfolioSummaryCards';
import ExpandableChart from '@/components/charts/ExpandableChart';
import { calculateMoneyWeightedReturn, calculateTimeWeightedReturn } from '@/lib/investment-performance';

type AllocationTab = 'holdings' | 'cashPct' | 'sector';

export default function AccountsPage() {
  const { portfolio, indices, loading, fetchAccountHistory, getAccountHistory, getAccountCashFlows } = useInvestmentData();
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [allocationTab, setAllocationTab] = useState<AllocationTab>('holdings');
  const [performanceMetric, setPerformanceMetric] = useState<'twr' | 'mwr'>('twr');

  const parentAccounts = useMemo(() => {
    if (!portfolio) return [];
    return portfolio.cashByAccount.map((account) => ({
      key: account.parentGuid,
      name: account.parentName,
      path: account.parentPath,
    }));
  }, [portfolio]);

  const effectiveSelectedAccount = selectedAccount || parentAccounts[0]?.key || '';
  const selectedParentAccount = useMemo(
    () => parentAccounts.find((account) => account.key === effectiveSelectedAccount),
    [effectiveSelectedAccount, parentAccounts]
  );
  const selectedCashAccount = useMemo(
    () => portfolio?.cashByAccount.find((account) => account.parentGuid === effectiveSelectedAccount),
    [effectiveSelectedAccount, portfolio]
  );

  // Filter holdings for selected account
  const filteredHoldings = useMemo(() => {
    if (!portfolio || !selectedParentAccount) return [];
    const parentPathPrefix = `${selectedParentAccount.path}:`;

    return portfolio.holdings.filter((holding) =>
      holding.accountPath === selectedParentAccount.path || holding.accountPath.startsWith(parentPathPrefix)
    );
  }, [portfolio, selectedParentAccount]);

  const holdingsWithCash = useMemo(() => {
    if (!selectedCashAccount || Math.abs(selectedCashAccount.cashBalance) < 0.01) {
      return filteredHoldings;
    }

    return [
      {
        accountGuid: selectedCashAccount.cashAccountGuid || selectedCashAccount.parentGuid,
        accountName:
          selectedCashAccount.cashSource === 'parent'
            ? `${selectedCashAccount.cashAccountName || selectedCashAccount.parentName} (Parent Cash)`
            : selectedCashAccount.cashAccountName || 'Cash',
        accountPath: selectedCashAccount.cashAccountPath || selectedCashAccount.parentPath,
        symbol: 'CASH',
        shares: 0,
        costBasis: selectedCashAccount.cashBalance,
        marketValue: selectedCashAccount.cashBalance,
        gainLoss: 0,
        gainLossPercent: 0,
        isCash: true,
        disableNavigation: true,
      },
      ...filteredHoldings,
    ];
  }, [filteredHoldings, selectedCashAccount]);

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

  const cashPctForAccount = useMemo(() => {
    if (!selectedCashAccount) return [];

    return [
      {
        category: 'Cash',
        value: selectedCashAccount.cashBalance,
        percent: selectedCashAccount.cashPercent,
      },
      {
        category: 'Investments',
        value: selectedCashAccount.investmentValue,
        percent: 100 - selectedCashAccount.cashPercent,
      },
    ];
  }, [selectedCashAccount]);

  const sectorExposureForAccount = useMemo(() => {
    if (!portfolio || !effectiveSelectedAccount) return [];
    return portfolio.sectorByAccount[effectiveSelectedAccount] || [];
  }, [effectiveSelectedAccount, portfolio]);

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
  const accountCashFlows = getAccountCashFlows(filteredAccountGuids);
  const performancePercent = useMemo(() => {
    if (performanceMetric === 'mwr') {
      return calculateMoneyWeightedReturn(accountHistory, accountCashFlows);
    }

    return calculateTimeWeightedReturn(accountHistory, accountCashFlows);
  }, [accountCashFlows, accountHistory, performanceMetric]);
  const safePerformancePercent = Number.isFinite(performancePercent) ? performancePercent : 0;

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

  const allocationTabs: { key: AllocationTab; label: string }[] = [
    { key: 'holdings', label: 'Holdings' },
    { key: 'cashPct', label: 'Cash %' },
    { key: 'sector', label: 'Sector' },
  ];

  const allocationTitle = allocationTab === 'holdings'
    ? 'Account Allocation'
    : allocationTab === 'cashPct'
      ? 'Cash % of Account'
      : 'Sector Exposure';

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Account View</h1>
          <p className="text-foreground-muted mt-1">Per-account investment breakdown</p>
        </div>
        <select
          value={effectiveSelectedAccount}
          onChange={(e) => setSelectedAccount(e.target.value)}
          className="px-4 py-2 bg-background-secondary border border-border rounded-lg text-foreground"
        >
          {parentAccounts.map(a => (
            <option key={a.key} value={a.key}>{a.name}</option>
          ))}
        </select>
      </header>

      {/* Filtered summary cards */}
      <PortfolioSummaryCards
        totalValue={filteredSummary.totalValue}
        totalCostBasis={filteredSummary.totalCostBasis}
        totalGainLoss={filteredSummary.totalGainLoss}
        dayChange={filteredSummary.dayChange}
        dayChangePercent={filteredSummary.dayChangePercent}
        performancePercent={safePerformancePercent}
        performanceMetric={performanceMetric}
      />

      {/* Charts */}
      <div className="grid md:grid-cols-2 gap-6 items-stretch">
        <div className="flex flex-col gap-0">
          <div className="flex flex-wrap gap-1 mb-2">
            {allocationTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setAllocationTab(tab.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  allocationTab === tab.key
                    ? 'bg-primary text-white'
                    : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <ExpandableChart title={allocationTitle}>
            {allocationTab === 'holdings' ? (
              <AllocationChart data={filteredAllocation} />
            ) : allocationTab === 'cashPct' ? (
              <AllocationChart data={cashPctForAccount} />
            ) : (
              <IndustryExposureChart data={sectorExposureForAccount} />
            )}
          </ExpandableChart>
        </div>
        <ExpandableChart title="Account Performance">
          <PerformanceChart
            title="Account Performance"
            data={accountHistory}
            cashFlows={accountCashFlows}
            indices={indices}
            returnMetric={performanceMetric}
            onReturnMetricChange={setPerformanceMetric}
          />
        </ExpandableChart>
      </div>

      {/* Filtered holdings table */}
      <HoldingsTable holdings={holdingsWithCash} />
    </div>
  );
}
