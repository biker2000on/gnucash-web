'use client';

import { useState, useMemo, useContext } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, AreaChart, Area, ReferenceLine } from 'recharts';
import { formatCurrency } from '@/lib/format';
import { ExpandedContext } from '@/components/charts/ExpandableChart';
import { computeZeroOffset, CHART_COLORS, GRADIENT_FILL_OPACITY } from '@/lib/chart-utils';

interface PerformanceChartProps {
  data: Array<{
    date: string;
    value: number;
  }>;
}

type Period = '1M' | '3M' | '6M' | '1Y' | '3Y' | '5Y' | 'ALL';

export function PerformanceChart({ data }: PerformanceChartProps) {
  const expanded = useContext(ExpandedContext);
  const [period, setPeriod] = useState<Period>('1Y');
  const [chartMode, setChartMode] = useState<'value' | 'percentChange'>('value');

  const filteredData = useMemo(() => {
    if (!data || data.length === 0) return [];
    if (period === 'ALL') return data;

    const now = new Date();
    const cutoffDate = new Date();

    switch (period) {
      case '1M': cutoffDate.setMonth(now.getMonth() - 1); break;
      case '3M': cutoffDate.setMonth(now.getMonth() - 3); break;
      case '6M': cutoffDate.setMonth(now.getMonth() - 6); break;
      case '1Y': cutoffDate.setFullYear(now.getFullYear() - 1); break;
      case '3Y': cutoffDate.setFullYear(now.getFullYear() - 3); break;
      case '5Y': cutoffDate.setFullYear(now.getFullYear() - 5); break;
    }

    return data.filter(d => new Date(d.date) >= cutoffDate);
  }, [data, period]);

  const displayData = useMemo(() => {
    if (chartMode === 'value' || filteredData.length === 0) return filteredData;
    const firstValue = filteredData[0].value;
    if (firstValue === 0) return filteredData;
    return filteredData.map(point => ({
      ...point,
      value: ((point.value - firstValue) / firstValue) * 100,
    }));
  }, [filteredData, chartMode]);

  const zeroOffset = useMemo(() => computeZeroOffset(displayData), [displayData]);

  const allPeriods: Period[] = ['1M', '3M', '6M', '1Y', '3Y', '5Y', 'ALL'];
  // In compact view, show fewer period options to avoid overflow
  const periods = expanded ? allPeriods : (['1M', '6M', '1Y', 'ALL'] as Period[]);

  if (!data || data.length === 0) {
    return (
      <div className="bg-background-secondary rounded-lg p-6 border border-border h-full">
        <h3 className="text-lg font-semibold text-foreground mb-4">Portfolio Performance</h3>
        <p className="text-foreground-muted">No performance data available</p>
      </div>
    );
  }

  return (
    <div className="bg-background-secondary rounded-lg p-6 border border-border h-full">
      <div className="flex items-center justify-between gap-2 mb-4">
        <h3 className="text-lg font-semibold text-foreground shrink-0">Portfolio Performance</h3>
        <div className="flex items-center gap-1 flex-wrap justify-end">
          <div className="flex gap-1">
            {periods.map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  period === p
                    ? 'bg-cyan-600 text-white'
                    : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <div className="flex gap-1 border-l border-border pl-1">
            <button
              onClick={() => setChartMode('value')}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                chartMode === 'value'
                  ? 'bg-cyan-600 text-white'
                  : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
              }`}
            >
              $
            </button>
            <button
              onClick={() => setChartMode('percentChange')}
              className={`px-3 py-1 text-xs rounded transition-colors ${
                chartMode === 'percentChange'
                  ? 'bg-cyan-600 text-white'
                  : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
              }`}
            >
              %
            </button>
          </div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={expanded ? "100%" : 300}>
        {chartMode === 'percentChange' ? (
          <AreaChart data={displayData}>
            <defs>
              <linearGradient id="perfFillGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.green} stopOpacity={GRADIENT_FILL_OPACITY} />
                <stop offset={`${zeroOffset * 100}%`} stopColor={CHART_COLORS.green} stopOpacity={GRADIENT_FILL_OPACITY} />
                <stop offset={`${zeroOffset * 100}%`} stopColor={CHART_COLORS.red} stopOpacity={GRADIENT_FILL_OPACITY} />
                <stop offset="100%" stopColor={CHART_COLORS.red} stopOpacity={GRADIENT_FILL_OPACITY} />
              </linearGradient>
              <linearGradient id="perfStrokeGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.green} stopOpacity={1} />
                <stop offset={`${zeroOffset * 100}%`} stopColor={CHART_COLORS.green} stopOpacity={1} />
                <stop offset={`${zeroOffset * 100}%`} stopColor={CHART_COLORS.red} stopOpacity={1} />
                <stop offset="100%" stopColor={CHART_COLORS.red} stopOpacity={1} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#404040" />
            <XAxis
              dataKey="date"
              stroke="#a3a3a3"
              tick={{ fill: '#a3a3a3', fontSize: 12 }}
              tickFormatter={(date) => new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            />
            <YAxis
              stroke="#a3a3a3"
              tick={{ fill: '#a3a3a3', fontSize: 12 }}
              tickFormatter={(value) => `${Number(value).toFixed(1)}%`}
            />
            <Tooltip
              contentStyle={{ backgroundColor: '#262626', border: '1px solid #404040', borderRadius: '8px' }}
              labelStyle={{ color: '#f5f5f5' }}
              formatter={(value: number | undefined) => value !== undefined ? [`${Number(value).toFixed(2)}%`, '% Change'] : ['', '']}
              labelFormatter={(date) => new Date(date).toLocaleDateString()}
            />
            <ReferenceLine y={0} stroke="#737373" strokeDasharray="3 3" />
            <Area
              type="monotone"
              dataKey="value"
              stroke="url(#perfStrokeGradient)"
              fill="url(#perfFillGradient)"
              fillOpacity={1}
              strokeWidth={2}
              dot={false}
              animationDuration={300}
              baseValue={0}
            />
          </AreaChart>
        ) : (
          <LineChart data={displayData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#404040" />
            <XAxis
              dataKey="date"
              stroke="#a3a3a3"
              tick={{ fill: '#a3a3a3', fontSize: 12 }}
              tickFormatter={(date) => new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            />
            <YAxis
              stroke="#a3a3a3"
              tick={{ fill: '#a3a3a3', fontSize: 12 }}
              tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
            />
            <Tooltip
              contentStyle={{ backgroundColor: '#262626', border: '1px solid #404040', borderRadius: '8px' }}
              labelStyle={{ color: '#f5f5f5' }}
              formatter={(value: number | undefined) => value !== undefined ? [formatCurrency(value), 'Portfolio Value'] : ['', '']}
              labelFormatter={(date) => new Date(date).toLocaleDateString()}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke="#06b6d4"
              strokeWidth={2}
              dot={false}
              animationDuration={300}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
