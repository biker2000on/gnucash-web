'use client';

import { useContext } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
  Legend,
} from 'recharts';
import { ExpandedContext } from '@/components/charts/ExpandableChart';
import type { BenchmarkSeriesPoint } from '@/lib/investment-benchmark';

interface BenchmarkChartProps {
  series: BenchmarkSeriesPoint[];
  indexName: string;
  height?: number;
}

/**
 * Growth-of-100 comparison: portfolio (time-weighted) vs the index, both
 * rebased to 100 at the window start. Portfolio uses --primary, index uses
 * --secondary, per the design system.
 */
export function BenchmarkChart({ series, indexName, height = 320 }: BenchmarkChartProps) {
  const expanded = useContext(ExpandedContext);

  if (series.length === 0) {
    return (
      <p className="text-foreground-muted text-sm">No comparison data available for this window.</p>
    );
  }

  const labels: Record<string, string> = {
    portfolio: 'Your portfolio',
    index: indexName,
  };

  return (
    <ResponsiveContainer width="100%" height={expanded ? '100%' : height}>
      <LineChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="date"
          stroke="var(--foreground-muted)"
          tick={{ fill: 'var(--foreground-muted)', fontSize: 12 }}
          tickFormatter={(date) =>
            new Date(date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
          }
          minTickGap={32}
        />
        <YAxis
          stroke="var(--foreground-muted)"
          tick={{ fill: 'var(--foreground-muted)', fontSize: 12 }}
          domain={['auto', 'auto']}
          tickFormatter={(value) => Number(value).toFixed(0)}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--surface-elevated)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
          }}
          labelStyle={{ color: 'var(--foreground)' }}
          itemStyle={{ fontFamily: 'var(--font-mono, monospace)' }}
          formatter={
            ((value: number | undefined, name?: string): [string, string] | [null, null] => {
              if (value === undefined || value === null) return [null, null];
              return [Number(value).toFixed(2), labels[name || ''] || name || ''];
            }) as never
          }
          labelFormatter={(date) => new Date(date).toLocaleDateString()}
        />
        <ReferenceLine y={100} stroke="var(--foreground-muted)" strokeDasharray="3 3" />
        <Legend
          verticalAlign="bottom"
          height={24}
          formatter={(val: string) => (
            <span style={{ color: 'var(--foreground-secondary)', fontSize: 12 }}>
              {labels[val] || val}
            </span>
          )}
        />
        <Line
          type="monotone"
          dataKey="portfolio"
          name="portfolio"
          stroke="var(--primary)"
          strokeWidth={2}
          dot={false}
          animationDuration={300}
          connectNulls
        />
        <Line
          type="monotone"
          dataKey="index"
          name="index"
          stroke="var(--secondary)"
          strokeWidth={2}
          dot={false}
          animationDuration={300}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
