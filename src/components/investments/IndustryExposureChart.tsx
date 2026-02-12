'use client';

import { useContext } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { formatCurrency } from '@/lib/format';
import { ExpandedContext } from '@/components/charts/ExpandableChart';

interface SectorExposure {
  sector: string;
  value: number;
  percent: number;
}

interface IndustryExposureChartProps {
  data: SectorExposure[];
}

const SECTOR_COLORS = [
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#a855f7', // purple
  '#f59e0b', // amber
  '#f43f5e', // rose
  '#3b82f6', // blue
  '#84cc16', // lime
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#8b5cf6', // violet
  '#22d3ee', // light cyan
];

export function IndustryExposureChart({ data }: IndustryExposureChartProps) {
  const expanded = useContext(ExpandedContext);

  if (!data || data.length === 0) {
    return (
      <div className="bg-background-secondary rounded-lg p-6 border border-border h-full">
        <h3 className="text-lg font-semibold text-foreground mb-4">Sector Exposure</h3>
        <p className="text-foreground-muted">No sector data available</p>
      </div>
    );
  }

  // Sort by value descending (should already be sorted from API)
  const sorted = [...data].sort((a, b) => b.value - a.value);

  const chartHeight = expanded
    ? Math.max(400, sorted.length * 40)
    : Math.max(250, sorted.length * 32);

  return (
    <div className="bg-background-secondary rounded-lg p-6 border border-border h-full">
      <h3 className="text-lg font-semibold text-foreground mb-4">Sector Exposure</h3>
      <ResponsiveContainer width="100%" height={expanded ? '100%' : chartHeight}>
        <BarChart
          data={sorted}
          layout="vertical"
          margin={{ top: 0, right: 20, left: 0, bottom: 0 }}
        >
          <XAxis
            type="number"
            tickFormatter={(v) => `${v.toFixed(0)}%`}
            tick={{ fill: '#a3a3a3', fontSize: 12 }}
            axisLine={{ stroke: '#404040' }}
            tickLine={{ stroke: '#404040' }}
          />
          <YAxis
            type="category"
            dataKey="sector"
            width={expanded ? 140 : 100}
            tick={{ fill: '#d4d4d4', fontSize: expanded ? 13 : 11 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#f5f5f5',
              border: '1px solid #d4d4d4',
              borderRadius: '8px',
              color: '#262626',
            }}
            labelStyle={{ color: '#262626', fontWeight: 600 }}
            formatter={(value, _name, entry) => {
              const numValue = typeof value === 'number' ? value : 0;
              const payload = (entry as { payload: SectorExposure }).payload;
              return [
                `${formatCurrency(payload.value)} (${numValue.toFixed(1)}%)`,
                'Allocation',
              ];
            }}
          />
          <Bar dataKey="percent" radius={[0, 4, 4, 0]} maxBarSize={24}>
            {sorted.map((entry, index) => (
              <Cell
                key={entry.sector}
                fill={SECTOR_COLORS[index % SECTOR_COLORS.length]}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
