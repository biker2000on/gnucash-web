'use client';

import { formatCurrency } from '@/lib/format';

interface ContributionLimitBarProps {
  current: number;
  limit: number;
  label: string;
  catchUp?: number;
}

export function ContributionLimitBar({ current, limit, label, catchUp }: ContributionLimitBarProps) {
  const percent = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0;
  const isOver = current > limit;

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-foreground-secondary">{label}</span>
        <span className={isOver ? 'text-red-400 font-medium' : 'text-foreground-secondary'}>
          {formatCurrency(current)} / {formatCurrency(limit)}
          {catchUp ? ` (incl. ${formatCurrency(catchUp)} catch-up)` : ''}
        </span>
      </div>
      <div className="h-2 bg-background-tertiary rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            isOver ? 'bg-red-500' : percent >= 90 ? 'bg-yellow-500' : 'bg-primary'
          }`}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
      <div className="text-right text-xs text-foreground-tertiary">
        {percent}% of limit
      </div>
    </div>
  );
}
