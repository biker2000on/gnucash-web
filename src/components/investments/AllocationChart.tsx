'use client';

import { useContext } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { formatCurrency } from '@/lib/format';
import { ExpandedContext } from '@/components/charts/ExpandableChart';

interface AllocationChartProps {
  data: Array<{
    category: string;
    value: number;
    percent: number;
  }>;
}

const COLORS = ['#06b6d4', '#10b981', '#a855f7', '#f59e0b', '#f43f5e', '#3b82f6', '#84cc16', '#ec4899'];

interface AllocationLegendPayload {
  percent?: number;
  category?: string;
}

function formatCompactCurrency(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
  return `$${value.toFixed(0)}`;
}

export function AllocationChart({ data }: AllocationChartProps) {
  const expanded = useContext(ExpandedContext);

  if (!data || data.length === 0) {
    return (
      <div className="bg-background-secondary rounded-lg p-6 border border-border h-full">
        <h3 className="text-lg font-semibold text-foreground mb-4">Portfolio Allocation</h3>
        <p className="text-foreground-muted">No allocation data available</p>
      </div>
    );
  }

  const total = data.reduce((sum, d) => sum + d.value, 0);

  return (
    <div className={`bg-background-secondary rounded-lg p-6 border border-border ${expanded ? 'h-full flex flex-col' : 'h-full'}`}>
      <h3 className="text-lg font-semibold text-foreground mb-4">Portfolio Allocation</h3>
      <div className={expanded ? 'flex-1 min-h-0' : ''}>
      <ResponsiveContainer width="100%" height={expanded ? "100%" : 300}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="category"
            cx="50%"
            cy="50%"
            innerRadius={expanded ? "50%" : 60}
            outerRadius={expanded ? "80%" : 100}
            stroke="var(--background)"
            strokeWidth={2}
          >
            {data.map((entry, index) => (
              <Cell key={entry.category} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central">
            <tspan x="50%" dy="-0.5em" fill="var(--foreground-muted)" fontSize={11}>Total</tspan>
            <tspan x="50%" dy="1.3em" fill="var(--foreground)" fontSize={14} fontWeight="bold">{formatCompactCurrency(total)}</tspan>
          </text>
          <Tooltip
            content={({ active, payload: tooltipPayload }) => {
              if (!active || !tooltipPayload || tooltipPayload.length === 0) return null;
              const entry = tooltipPayload[0];
              const entryPayload = (entry?.payload ?? {}) as AllocationLegendPayload & { value?: number };
              const numValue = typeof entry?.value === 'number' ? entry.value : 0;
              const percent = total > 0 ? (numValue / total) * 100 : 0;
              return (
                <div className="bg-background border border-border rounded-lg p-3 shadow-xl">
                  <p className="text-sm font-medium text-foreground">{entryPayload.category ?? ''}</p>
                  <p className="text-sm text-foreground-secondary">
                    {formatCurrency(numValue)} ({percent.toFixed(1)}%)
                  </p>
                </div>
              );
            }}
          />
          {expanded && (
            <Legend
              wrapperStyle={{ maxHeight: '120px', overflowY: 'auto' }}
              formatter={(value, entry) => {
                const payload = (entry?.payload ?? {}) as AllocationLegendPayload;
                return (
                  <span style={{ color: '#d4d4d4' }}>
                    {value} ({(payload.percent ?? 0).toFixed(1)}%)
                  </span>
                );
              }}
            />
          )}
        </PieChart>
      </ResponsiveContainer>
      </div>
    </div>
  );
}
