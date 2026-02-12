'use client';

import { formatCurrency } from '@/lib/format';

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

interface CashAllocationCardProps {
  cashByAccount: CashByAccount[];
  overallCash: OverallCash;
}

function getCashColor(percent: number): string {
  if (percent > 20) return 'text-red-400';
  if (percent > 10) return 'text-amber-400';
  return 'text-emerald-400';
}

function getBarColor(percent: number): string {
  if (percent > 20) return 'bg-red-400/70';
  if (percent > 10) return 'bg-amber-400/70';
  return 'bg-emerald-400/70';
}

export function CashAllocationCard({ cashByAccount, overallCash }: CashAllocationCardProps) {
  if (!cashByAccount || cashByAccount.length === 0) {
    return (
      <div className="bg-background-secondary rounded-lg p-6 border border-border">
        <h3 className="text-lg font-semibold text-foreground mb-4">Cash Allocation</h3>
        <p className="text-foreground-muted">No cash accounts detected</p>
      </div>
    );
  }

  return (
    <div className="bg-background-secondary rounded-lg border border-border overflow-hidden">
      <div className="p-4 border-b border-border">
        <h3 className="text-lg font-semibold text-foreground">Cash Allocation</h3>
      </div>
      <div className="divide-y divide-border">
        {/* Overall Total Row */}
        <div className="p-4 bg-background-tertiary/30">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-foreground">Overall Portfolio</span>
            <span className={`font-bold text-lg ${getCashColor(overallCash.cashPercent)}`}>
              {overallCash.cashPercent.toFixed(1)}% cash
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm text-foreground-secondary mb-2">
            <span>Cash: {formatCurrency(overallCash.totalCashBalance)}</span>
            <span>Invested: {formatCurrency(overallCash.totalInvestmentValue)}</span>
            <span>Total: {formatCurrency(overallCash.totalValue)}</span>
          </div>
          <CashBar cashPercent={overallCash.cashPercent} />
        </div>

        {/* Per-Account Rows */}
        {cashByAccount.map((account) => (
          <div key={account.parentGuid} className="p-4">
            <div className="flex items-center justify-between mb-1">
              <div>
                <span className="font-medium text-foreground">{account.parentName}</span>
                <span className="text-sm text-foreground-muted ml-2">{account.parentPath}</span>
              </div>
              <span className={`font-semibold ${getCashColor(account.cashPercent)}`}>
                {account.cashPercent.toFixed(1)}%
              </span>
            </div>
            <div className="flex items-center gap-4 text-sm text-foreground-secondary mb-2">
              <span>Cash: {formatCurrency(account.cashBalance)}</span>
              <span>Invested: {formatCurrency(account.investmentValue)}</span>
            </div>
            <CashBar cashPercent={account.cashPercent} />
          </div>
        ))}
      </div>
    </div>
  );
}

function CashBar({ cashPercent }: { cashPercent: number }) {
  const clampedPercent = Math.min(Math.max(cashPercent, 0), 100);

  return (
    <div className="w-full h-2 bg-cyan-600/30 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${getBarColor(cashPercent)}`}
        style={{ width: `${clampedPercent}%` }}
      />
    </div>
  );
}
