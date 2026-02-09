'use client';

import { useState, useMemo, useContext } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatCurrency } from '@/lib/format';
import { ExpandedContext } from '@/components/charts/ExpandableChart';

interface PerformanceChartProps {
  data: Array<{
    date: string;
    value: number;
  }>;
}

type Period = '1M' | '3M' | '6M' | '1Y' | 'ALL';

export function PerformanceChart({ data }: PerformanceChartProps) {
  const expanded = useContext(ExpandedContext);
  const [period, setPeriod] = useState<Period>('1Y');

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
    }

    return data.filter(d => new Date(d.date) >= cutoffDate);
  }, [data, period]);

  const periods: Period[] = ['1M', '3M', '6M', '1Y', 'ALL'];

  if (!data || data.length === 0) {
    return (
      <div className={`bg-background-secondary rounded-lg p-6 border border-border ${expanded ? 'h-full' : ''}`}>
        <h3 className="text-lg font-semibold text-foreground mb-4">Portfolio Performance</h3>
        <p className="text-foreground-muted">No performance data available</p>
      </div>
    );
  }

  return (
    <div className={`bg-background-secondary rounded-lg p-6 border border-border ${expanded ? 'h-full' : ''}`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-foreground">Portfolio Performance</h3>
        <div className="flex gap-1">
          {periods.map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1 text-sm rounded transition-colors ${
                period === p
                  ? 'bg-cyan-600 text-white'
                  : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={expanded ? "100%" : 300}>
        <LineChart data={filteredData}>
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
      </ResponsiveContainer>
    </div>
  );
}
