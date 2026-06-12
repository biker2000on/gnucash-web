'use client';

/**
 * Monte Carlo projection chart: confidence bands (10-90 light, 25-75 darker),
 * median line, optional deterministic overlay, FI number and retirement age
 * reference lines. X axis = age, Y = real (today's $) portfolio value.
 */

import { useMemo } from 'react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import type { MonteCarloResult } from '@/lib/fire/monte-carlo';
import { fmt, fmtCompact, fmtFull } from './shared';

interface ChartRow {
  age: number;
  band80: [number, number];
  band50: [number, number];
  p50: number;
  det: number | null;
}

interface MonteCarloChartProps {
  result: MonteCarloResult;
  deterministic: number[] | null;
  retirementAge: number;
  showDeterministic: boolean;
}

interface TooltipPayloadEntry {
  dataKey?: string | number;
  value?: number | [number, number];
  payload?: ChartRow;
}

function BandTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayloadEntry[]; label?: string | number }) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div
      className="rounded-lg border border-border bg-surface px-3 py-2 text-xs"
      style={{ fontFeatureSettings: "'tnum'" }}
    >
      <p className="font-semibold text-foreground mb-1.5">Age {label}</p>
      <table className="font-mono">
        <tbody>
          <Row label="90th pct" value={row.band80[1]} muted />
          <Row label="75th pct" value={row.band50[1]} muted />
          <Row label="Median" value={row.p50} />
          <Row label="25th pct" value={row.band50[0]} muted />
          <Row label="10th pct" value={row.band80[0]} muted />
          {row.det !== null && <Row label="Deterministic" value={row.det} muted />}
        </tbody>
      </table>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <tr className={muted ? 'text-foreground-muted' : 'text-primary'}>
      <td className="pr-3">{label}</td>
      <td className="text-right">{fmtFull.format(value)}</td>
    </tr>
  );
}

export default function MonteCarloChart({ result, deterministic, retirementAge, showDeterministic }: MonteCarloChartProps) {
  const data = useMemo<ChartRow[]>(
    () =>
      result.years.map((y, i) => ({
        age: y.age,
        band80: [Math.round(y.p10), Math.round(y.p90)] as [number, number],
        band50: [Math.round(y.p25), Math.round(y.p75)] as [number, number],
        p50: Math.round(y.p50),
        det:
          showDeterministic && deterministic && i < deterministic.length
            ? Math.round(deterministic[i])
            : null,
      })),
    [result, deterministic, showDeterministic]
  );

  return (
    <div className="h-96">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 56, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis
            dataKey="age"
            stroke="var(--color-foreground-muted)"
            tick={{ fill: 'var(--color-foreground-muted)', fontSize: 12 }}
            label={{ value: 'Age', position: 'insideBottomRight', offset: -2, fill: 'var(--color-foreground-muted)', fontSize: 12 }}
          />
          <YAxis
            stroke="var(--color-foreground-muted)"
            tick={{ fill: 'var(--color-foreground-muted)', fontSize: 12 }}
            tickFormatter={(v: number) => fmtCompact(v)}
            width={64}
          />
          <Tooltip content={<BandTooltip />} />
          {/* 10-90 band (light) */}
          <Area
            type="monotone"
            dataKey="band80"
            stroke="none"
            fill="var(--color-primary, #2dd4bf)"
            fillOpacity={0.1}
            isAnimationActive={false}
            name="10th–90th percentile"
            activeDot={false}
          />
          {/* 25-75 band (darker) */}
          <Area
            type="monotone"
            dataKey="band50"
            stroke="none"
            fill="var(--color-primary, #2dd4bf)"
            fillOpacity={0.2}
            isAnimationActive={false}
            name="25th–75th percentile"
            activeDot={false}
          />
          {/* Median */}
          <Line
            type="monotone"
            dataKey="p50"
            stroke="var(--color-primary, #2dd4bf)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            name="Median"
          />
          {/* Deterministic overlay */}
          {showDeterministic && deterministic && (
            <Line
              type="monotone"
              dataKey="det"
              stroke="var(--color-secondary, #60a5fa)"
              strokeWidth={1.5}
              strokeDasharray="6 3"
              dot={false}
              isAnimationActive={false}
              name="Deterministic"
            />
          )}
          {/* FI number */}
          {Number.isFinite(result.fiNumber) && result.fiNumber > 0 && (
            <ReferenceLine
              y={result.fiNumber}
              stroke="var(--color-warning, #fbbf24)"
              strokeDasharray="8 4"
              label={{
                value: `FI ${fmt.format(result.fiNumber)}`,
                position: 'right',
                fill: 'var(--color-warning, #fbbf24)',
                fontSize: 11,
              }}
            />
          )}
          {/* Retirement age */}
          <ReferenceLine
            x={retirementAge}
            stroke="var(--color-secondary, #60a5fa)"
            strokeDasharray="4 4"
            label={{
              value: `Retire ${retirementAge}`,
              position: 'insideTopLeft',
              fill: 'var(--color-secondary, #60a5fa)',
              fontSize: 11,
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
