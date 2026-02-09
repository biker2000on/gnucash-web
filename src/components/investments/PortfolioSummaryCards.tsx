'use client';

import { formatCurrency } from '@/lib/format';

interface PortfolioSummaryCardsProps {
  totalValue: number;
  totalCostBasis: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  dayChange?: number;
  dayChangePercent?: number;
}

export function PortfolioSummaryCards({
  totalValue,
  totalCostBasis,
  totalGainLoss,
  totalGainLossPercent,
  dayChange = 0,
  dayChangePercent = 0,
}: PortfolioSummaryCardsProps) {
  const gainLossColor = totalGainLoss >= 0 ? 'text-emerald-400' : 'text-red-400';
  const dayChangeColor = dayChange >= 0 ? 'text-emerald-400' : 'text-red-400';

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
          {formatCurrency(totalGainLoss)} ({totalGainLossPercent >= 0 ? '+' : ''}{totalGainLossPercent.toFixed(2)}%)
        </p>
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
