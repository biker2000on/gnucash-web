'use client';

import { formatCurrency } from '@/lib/format';
import {
  CostBasisCoverageMark,
  CoveredSliceNote,
  gainHeading,
  BASIS_CONSEQUENCE,
} from '@/components/investments/CostBasisCoverageMark';
import type { CostBasisCoverage } from '@/lib/commodities';

interface PortfolioSummaryCardsProps {
  totalValue: number;
  totalCostBasis: number;
  /**
   * What `totalCostBasis` and `totalGainLoss` describe. Required, not optional:
   * these cards summarise a whole portfolio in three numbers, and a summary
   * that silently omits its coverage is exactly how a partial basis gets read
   * as a complete one.
   */
  totalCostBasisCoverage: CostBasisCoverage;
  /** Sum of the per-holding covered gains — never totalValue - totalCostBasis. */
  totalGainLoss: number;
  performancePercent: number;
  performanceMetric: 'twr' | 'mwr';
}

export function PortfolioSummaryCards({
  totalValue,
  totalCostBasis,
  totalCostBasisCoverage,
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

  const basisMark = (
    <CostBasisCoverageMark coverage={totalCostBasisCoverage} consequence={BASIS_CONSEQUENCE} />
  );

  const rows = [
    { label: 'Total Value', value: formatCurrency(totalValue), color: 'text-foreground' },
    {
      label: 'Cost Basis',
      value: <>{formatCurrency(totalCostBasis)}{basisMark}</>,
      color: 'text-foreground',
    },
    {
      // "Total Gain/Loss" only when the basis behind it covers every share.
      label: `Total ${gainHeading(totalCostBasisCoverage)}`,
      value: <>{formatCurrency(totalGainLoss)}{basisMark}</>,
      color: gainLossColor,
    },
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
          <p className="text-2xl font-bold text-foreground">
            {formatCurrency(totalCostBasis)}
            {basisMark}
          </p>
          <CoveredSliceNote coverage={totalCostBasisCoverage} className="mt-1" />
        </div>
        <div className="bg-background-secondary rounded-lg p-4 border border-border">
          <p className="text-foreground-muted text-sm">Total {gainHeading(totalCostBasisCoverage)}</p>
          <p className={`text-2xl font-bold ${gainLossColor}`}>
            {formatCurrency(totalGainLoss)}
            {basisMark}
          </p>
          <CoveredSliceNote coverage={totalCostBasisCoverage} className="mt-1" />
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
