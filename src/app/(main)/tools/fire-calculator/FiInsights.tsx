'use client';

/**
 * Secondary Monte Carlo insights:
 *  - Histogram of the age at which FI is first reached across simulations
 *  - Sequence-of-returns sensitivity: success rate at retirement age +/- 2 yrs
 */

import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { MonteCarloResult } from '@/lib/fire/monte-carlo';
import { fmtPct } from './shared';

/* ------------------------------------------------------------------ */
/* FI age histogram                                                    */
/* ------------------------------------------------------------------ */

/**
 * Custom tooltip matching MonteCarloChart's BandTooltip pattern: explicit
 * surface/border/foreground colors from the app's CSS variables, so text
 * stays readable in dark mode (recharts' default item color is #000).
 */
function HistogramTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value?: number | string }[];
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const share = Number(payload[0]?.value ?? 0);
  return (
    <div
      className="rounded-lg border border-border bg-surface px-3 py-2 text-xs"
      style={{ fontFeatureSettings: "'tnum'" }}
    >
      <p className="font-semibold text-foreground mb-0.5">FI at age {label}</p>
      <p className="font-mono text-primary">{fmtPct(share, 1)} of simulations</p>
    </div>
  );
}

export function FiAgeHistogram({ result }: { result: MonteCarloResult }) {
  const data = useMemo(
    () =>
      result.fiAgeDistribution.map(b => ({
        age: b.age,
        share: b.count / result.numSimulations,
      })),
    [result]
  );

  if (data.length === 0) {
    return (
      <p className="text-sm text-foreground-muted py-8 text-center">
        No simulated path reaches financial independence within the horizon.
        Try increasing contributions or lowering expenses.
      </p>
    );
  }

  return (
    <div className="h-44">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="age"
            stroke="var(--color-foreground-muted)"
            tick={{ fill: 'var(--color-foreground-muted)', fontSize: 11 }}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke="var(--color-foreground-muted)"
            tick={{ fill: 'var(--color-foreground-muted)', fontSize: 11 }}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            width={36}
          />
          <Tooltip
            cursor={{ fill: 'var(--color-surface-hover, #1e2d4a)', opacity: 0.4 }}
            content={<HistogramTooltip />}
          />
          <Bar dataKey="share" isAnimationActive={false} radius={[2, 2, 0, 0]}>
            {data.map(d => (
              <Cell
                key={d.age}
                fill="var(--color-primary, #2dd4bf)"
                fillOpacity={result.medianFiAge !== null && d.age === result.medianFiAge ? 0.9 : 0.45}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sequence-of-returns sensitivity                                     */
/* ------------------------------------------------------------------ */

export function SensitivityRow({
  rows,
  retirementAge,
}: {
  rows: { retirementAge: number; successRate: number }[];
  retirementAge: number;
}) {
  return (
    <div>
      <div className="grid grid-cols-5 gap-2">
        {rows.map(row => {
          const isCurrent = row.retirementAge === retirementAge;
          const pct = row.successRate * 100;
          const color =
            pct >= 90 ? 'text-positive' : pct >= 75 ? 'text-warning' : 'text-negative';
          return (
            <div
              key={row.retirementAge}
              className={`rounded-lg border px-2 py-3 text-center ${
                isCurrent ? 'border-primary/50 bg-primary/10' : 'border-border bg-background-tertiary/40'
              }`}
            >
              <p className="text-xs text-foreground-muted">Age {row.retirementAge}</p>
              <p
                className={`mt-1 text-lg font-semibold font-mono ${color}`}
                style={{ fontFeatureSettings: "'tnum'" }}
              >
                {pct.toFixed(0)}%
              </p>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-foreground-muted mt-3">
        Sequence-of-returns risk: a few bad market years right around retirement can make
        or break an otherwise identical plan. Delaying retirement usually improves the odds;
        retiring earlier shifts more weight onto early-retirement market luck.
      </p>
    </div>
  );
}
