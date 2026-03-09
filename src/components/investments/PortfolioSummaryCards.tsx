'use client';

'use client';

import { formatCurrency } from '@/lib/format';

interface PortfolioSummaryCardsProps {
  totalValue: number;
  totalCostBasis: number;
  totalGainLoss: number;
  dayChange?: number;
  dayChangePercent?: number;
  performancePercent: number;
  performanceMetric: 'twr' | 'mwr';
}

export function PortfolioSummaryCards({
  totalValue,
  totalCostBasis,
  totalGainLoss,
  dayChange = 0,
  dayChangePercent = 0,
  performancePercent = 0,
  performanceMetric,
}: PortfolioSummaryCardsProps) {
  const gainLossColor = totalGainLoss >= 0 ? 'text-emerald-400' : 'text-red-400';
  const dayChangeColor = dayChange >= 0 ? 'text-emerald-400' : 'text-red-400';
  const safePerformancePercent = Number.isFinite(performancePercent) ? performancePercent : 0;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div className="bg-background-secondary rounded-lg p-4 border border-border">
        <p className="text-foreground-muted text-sm">Total Value</p>
        <p className="text-2xl font-bold text-foreground">{formatCurrency(totalValue)}</p>
      </div>
      <div className="bg-background-secondary rounded-lg p-4 border border-border">
        <p className="text-foreground-muted text-sm">Cost Basis</p>
        <p className="text-2xl font-bold text-foreground">{formatCurrency(totalCostBasis)}</p>
      </div>
      <div className="bg-background-secondary rounded-lg p-4 border border-border">
        <p className="text-foreground-muted text-sm">Total Gain/Loss</p>
        <p className={`text-2xl font-bold ${gainLossColor}`}>
          {formatCurrency(totalGainLoss)}
        </p>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs uppercase tracking-wider text-foreground-muted">
            {performanceMetric === 'twr' ? 'TWR' : 'MWR'}
          </span>
          <span className={`text-sm font-semibold ${safePerformancePercent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {safePerformancePercent >= 0 ? '+' : ''}{safePerformancePercent.toFixed(2)}%
          </span>
        </div>
      </div>
      <div className="bg-background-secondary rounded-lg p-4 border border-border">
        <p className="text-foreground-muted text-sm">Day Change</p>
        <p className={`text-2xl font-bold ${dayChangeColor}`}>
          {formatCurrency(dayChange)} ({dayChangePercent >= 0 ? '+' : ''}{dayChangePercent.toFixed(2)}%)
        </p>
      </div>
    </div>
  );
}
