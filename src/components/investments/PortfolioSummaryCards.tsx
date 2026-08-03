'use client';

import { formatCurrency } from '@/lib/format';

interface PortfolioSummaryCardsProps {
  totalValue: number;
  totalCostBasis: number;
  totalGainLoss: number;
  performancePercent: number;
  performanceMetric: 'twr' | 'mwr';
}

export function PortfolioSummaryCards({
  totalValue,
  totalCostBasis,
  totalGainLoss,
  performancePercent = 0,
  performanceMetric,
}: PortfolioSummaryCardsProps) {
  const gainLossColor = totalGainLoss >= 0 ? 'text-positive' : 'text-negative';
  const safePerformancePercent = Number.isFinite(performancePercent) ? performancePercent : 0;
  const performanceColor = safePerformancePercent >= 0 ? 'text-positive' : 'text-negative';
  const performanceLabel = performanceMetric === 'twr' ? 'TWR' : 'MWR';
  const performanceValue = (
    <span className={performanceColor}>
      {safePerformancePercent >= 0 ? '+' : ''}{safePerformancePercent.toFixed(2)}%
    </span>
  );

  const rows = [
    { label: 'Total Value', value: formatCurrency(totalValue), color: 'text-foreground' },
    { label: 'Cost Basis', value: formatCurrency(totalCostBasis), color: 'text-foreground' },
    { label: 'Total Gain/Loss', value: formatCurrency(totalGainLoss), color: gainLossColor },
    { label: performanceLabel, value: performanceValue, color: '' },
  ];

  return (
    <>
      {/* Phone: one condensed card with a row per metric */}
      <div className="sm:hidden bg-background-secondary rounded-lg border border-border divide-y divide-border/40">
        {rows.map(row => (
          <div key={row.label} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="text-xs text-foreground-muted uppercase tracking-wider">{row.label}</span>
            <span
              className={`text-sm font-bold font-mono ${row.color}`}
              style={{ fontFeatureSettings: "'tnum'" }}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>

      {/* Tablet/desktop: card grid */}
      <div className="hidden sm:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
              {performanceLabel}
            </span>
            <span className={`text-sm font-semibold ${performanceColor}`}>
              {safePerformancePercent >= 0 ? '+' : ''}{safePerformancePercent.toFixed(2)}%
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
