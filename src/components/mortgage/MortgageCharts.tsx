'use client';

import { useMemo } from 'react';
import {
  ComposedChart,
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { AmortizationRow } from './AmortizationTable';

/* ------------------------------------------------------------------ */
/* Formatters                                                          */
/* ------------------------------------------------------------------ */

function compactCurrency(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
  return `$${value.toFixed(0)}`;
}

const fmtFull = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Reduce a monthly schedule to one point per year (using each year's final
 * month) so long (30-year) schedules stay readable. `startYear` labels the
 * x-axis with calendar years when a start date is known.
 */
function toYearlyPoints(schedule: AmortizationRow[], startMonthOffset: number) {
  const byYear = new Map<number, AmortizationRow>();
  for (const row of schedule) {
    const yearIdx = Math.floor((row.month - 1 + startMonthOffset) / 12);
    byYear.set(yearIdx, row); // last row of the year wins
  }
  return byYear;
}

interface MortgageChartsProps {
  baseline: AmortizationRow[];
  accelerated: AmortizationRow[];
  /** Calendar year the loan starts (for x-axis labels); falls back to year offsets */
  startYear?: number;
  /** Month (0-11) the loan starts, for aligning yearly buckets */
  startMonth?: number;
  acceleratedLabel?: string;
}

interface CustomTooltipEntry {
  name: string;
  value: number;
  color: string;
}

function ChartTooltip({ active, payload, label, suffix }: {
  active?: boolean;
  payload?: CustomTooltipEntry[];
  label?: string | number;
  suffix?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-background border border-border rounded-lg p-3 shadow-xl">
      <p className="text-xs text-foreground-muted mb-2">{suffix ?? ''}{label}</p>
      <div className="space-y-1">
        {payload.map((entry, i) => (
          <div key={i} className="flex items-center justify-between gap-4 text-sm">
            <span className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
              <span className="text-foreground-secondary">{entry.name}</span>
            </span>
            <span className="font-medium text-foreground font-mono">{fmtFull.format(entry.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MortgageCharts({
  baseline,
  accelerated,
  startYear,
  startMonth = 0,
  acceleratedLabel = 'With strategy',
}: MortgageChartsProps) {
  // --- Balance-over-time data (baseline vs strategy), one point per year ---
  const balanceData = useMemo(() => {
    const baseYearly = toYearlyPoints(baseline, startMonth);
    const accelYearly = toYearlyPoints(accelerated, startMonth);
    const maxYear = Math.max(
      baseYearly.size ? Math.max(...baseYearly.keys()) : 0,
      accelYearly.size ? Math.max(...accelYearly.keys()) : 0,
    );
    const points: Array<{ year: string | number; baseline: number | null; strategy: number | null }> = [];
    // Year 0 = starting balance
    const startBal = baseline[0]
      ? baseline[0].balance + baseline[0].principal + baseline[0].extra
      : 0;
    points.push({
      year: startYear ?? 0,
      baseline: startBal,
      strategy: startBal,
    });
    for (let y = 0; y <= maxYear; y++) {
      points.push({
        year: startYear != null ? startYear + y + 1 : y + 1,
        baseline: baseYearly.has(y) ? baseYearly.get(y)!.balance : (y > 0 && !baseYearly.has(y) ? 0 : null),
        strategy: accelYearly.has(y) ? accelYearly.get(y)!.balance : (y > 0 && !accelYearly.has(y) ? 0 : null),
      });
    }
    return points;
  }, [baseline, accelerated, startYear, startMonth]);

  // --- Principal vs Interest composition per year (for the strategy) ---
  const compositionData = useMemo(() => {
    const byYear = new Map<number, { principal: number; interest: number; extra: number }>();
    for (const row of accelerated) {
      const yearIdx = Math.floor((row.month - 1 + startMonth) / 12);
      const agg = byYear.get(yearIdx) ?? { principal: 0, interest: 0, extra: 0 };
      agg.principal += row.principal;
      agg.interest += row.interest;
      agg.extra += row.extra;
      byYear.set(yearIdx, agg);
    }
    return [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([yearIdx, agg]) => ({
        year: startYear != null ? startYear + yearIdx : yearIdx + 1,
        principal: Math.round(agg.principal),
        interest: Math.round(agg.interest),
        extra: Math.round(agg.extra),
      }));
  }, [accelerated, startYear, startMonth]);

  if (baseline.length === 0 && accelerated.length === 0) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Balance to zero over time */}
      <div className="bg-surface/30 border border-border rounded-xl p-4">
        <h4 className="text-sm font-semibold text-foreground mb-1">Balance over time</h4>
        <p className="text-xs text-foreground-muted mb-3">Remaining loan balance paid down to zero</p>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={balanceData} margin={{ top: 5, right: 12, left: 4, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="year" stroke="var(--foreground-secondary)" tick={{ fill: 'var(--foreground-secondary)', fontSize: 11 }} axisLine={{ stroke: 'var(--border)' }} tickLine={{ stroke: 'var(--border)' }} />
            <YAxis tickFormatter={compactCurrency} width={52} stroke="var(--foreground-secondary)" tick={{ fill: 'var(--foreground-secondary)', fontSize: 11 }} axisLine={{ stroke: 'var(--border)' }} tickLine={{ stroke: 'var(--border)' }} />
            <Tooltip content={<ChartTooltip suffix="Year " />} />
            <Legend wrapperStyle={{ paddingTop: 8 }} formatter={(v) => <span className="text-foreground-secondary text-xs">{v}</span>} />
            <Area type="monotone" dataKey="baseline" name="Regular payments" stroke="var(--foreground-muted)" strokeWidth={1.5} strokeDasharray="4 4" fill="none" connectNulls dot={false} />
            <Area type="monotone" dataKey="strategy" name={acceleratedLabel} stroke="var(--primary)" strokeWidth={2.5} fill="var(--primary)" fillOpacity={0.12} connectNulls dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Principal vs interest composition */}
      <div className="bg-surface/30 border border-border rounded-xl p-4">
        <h4 className="text-sm font-semibold text-foreground mb-1">Principal vs interest</h4>
        <p className="text-xs text-foreground-muted mb-3">How each year&apos;s payments split — interest shrinks as principal grows</p>
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={compositionData} margin={{ top: 5, right: 12, left: 4, bottom: 5 }} stackOffset="none">
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="year" stroke="var(--foreground-secondary)" tick={{ fill: 'var(--foreground-secondary)', fontSize: 11 }} axisLine={{ stroke: 'var(--border)' }} tickLine={{ stroke: 'var(--border)' }} />
            <YAxis tickFormatter={compactCurrency} width={52} stroke="var(--foreground-secondary)" tick={{ fill: 'var(--foreground-secondary)', fontSize: 11 }} axisLine={{ stroke: 'var(--border)' }} tickLine={{ stroke: 'var(--border)' }} />
            <Tooltip content={<ChartTooltip suffix="Year " />} />
            <Legend wrapperStyle={{ paddingTop: 8 }} formatter={(v) => <span className="text-foreground-secondary text-xs">{v}</span>} />
            <Area type="monotone" dataKey="interest" name="Interest" stackId="1" stroke="var(--negative)" fill="var(--negative)" fillOpacity={0.25} />
            <Area type="monotone" dataKey="principal" name="Principal" stackId="1" stroke="var(--positive)" fill="var(--positive)" fillOpacity={0.25} />
            <Area type="monotone" dataKey="extra" name="Extra principal" stackId="1" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.3} />
            <Line type="monotone" dataKey="interest" name="Interest" stroke="var(--negative)" strokeWidth={2} dot={false} legendType="none" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
