'use client';

import { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { DebtPlan } from '@/lib/debt-payoff';

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

/** Convert a 0-based month offset from today into a "Mon YYYY" label */
export function monthToLabel(monthOffset: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + monthOffset);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */

interface TooltipEntry {
  name: string;
  value: number | null;
  color: string;
}

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-background border border-border rounded-lg p-3 shadow-xl">
      <p className="text-xs text-foreground-muted mb-2">{label}</p>
      <div className="space-y-1">
        {payload.map((entry, i) => (
          entry.value === null ? null : (
            <div key={i} className="flex items-center justify-between gap-4 text-sm">
              <span className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
                <span className="text-foreground-secondary">{entry.name}</span>
              </span>
              <span className="font-medium text-foreground font-mono" style={{ fontFeatureSettings: "'tnum'" }}>
                {fmtFull.format(entry.value)}
              </span>
            </div>
          )
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chart                                                               */
/* ------------------------------------------------------------------ */

interface DebtPayoffChartProps {
  snowball: DebtPlan;
  avalanche: DebtPlan;
  minimum: DebtPlan;
}

interface ChartPoint {
  label: string;
  snowball: number | null;
  avalanche: number | null;
  minimum: number | null;
}

/**
 * Total remaining balance over time, one line per strategy plus the
 * minimum-payments-only baseline.
 */
export function DebtPayoffChart({ snowball, avalanche, minimum }: DebtPayoffChartProps) {
  const data = useMemo<ChartPoint[]>(() => {
    const plans = [snowball, avalanche, minimum];
    const maxLen = Math.max(...plans.map((p) => p.timeline.length));
    if (maxLen === 0) return [];

    // Balance at a given month: timeline value while running, 0 after a
    // completed plan ends, null past the cap for plans that never finish.
    const valueAt = (plan: DebtPlan, month: number): number | null => {
      if (month < plan.timeline.length) return plan.timeline[month].totalBalance;
      return plan.capped ? null : 0;
    };

    const points: ChartPoint[] = [];
    // Downsample long schedules so the chart stays readable (~240 points max)
    const step = Math.max(1, Math.ceil(maxLen / 240));
    for (let m = 0; m < maxLen; m += step) {
      points.push({
        label: monthToLabel(m),
        snowball: valueAt(snowball, m),
        avalanche: valueAt(avalanche, m),
        minimum: valueAt(minimum, m),
      });
    }
    // Always include the final month so lines reach zero
    const last = maxLen - 1;
    if ((maxLen - 1) % step !== 0) {
      points.push({
        label: monthToLabel(last),
        snowball: valueAt(snowball, last),
        avalanche: valueAt(avalanche, last),
        minimum: valueAt(minimum, last),
      });
    }
    return points;
  }, [snowball, avalanche, minimum]);

  if (data.length === 0) return null;

  return (
    <div className="bg-surface/30 border border-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-foreground mb-1">Balance over time</h3>
      <p className="text-xs text-foreground-muted mb-3">
        Total remaining debt under each strategy vs minimum payments only
      </p>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ top: 5, right: 12, left: 4, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="label"
            stroke="var(--foreground-secondary)"
            tick={{ fill: 'var(--foreground-secondary)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--border)' }}
            tickLine={{ stroke: 'var(--border)' }}
            minTickGap={40}
          />
          <YAxis
            tickFormatter={compactCurrency}
            width={56}
            stroke="var(--foreground-secondary)"
            tick={{ fill: 'var(--foreground-secondary)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--border)' }}
            tickLine={{ stroke: 'var(--border)' }}
          />
          <Tooltip content={<ChartTooltip />} />
          <Legend
            wrapperStyle={{ paddingTop: 8 }}
            formatter={(v) => <span className="text-foreground-secondary text-xs">{v}</span>}
          />
          <Line
            type="monotone"
            dataKey="minimum"
            name="Minimum payments only"
            stroke="var(--foreground-muted)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="snowball"
            name="Snowball"
            stroke="var(--secondary)"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="avalanche"
            name="Avalanche"
            stroke="var(--primary)"
            strokeWidth={2.5}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
