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
            outerRadius={expanded ? "80%" : 100}
          >
            {data.map((entry, index) => (
              <Cell key={entry.category} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: '#f5f5f5',
              border: '1px solid #d4d4d4',
              borderRadius: '8px',
              color: '#262626'
            }}
            labelStyle={{ color: '#262626' }}
            formatter={(value, _name, entry) => {
              const payload = (entry?.payload ?? {}) as AllocationLegendPayload;
              const numValue = typeof value === 'number' ? value : 0;
              return [
                `${formatCurrency(numValue)} (${(payload.percent ?? 0).toFixed(1)}%)`,
                payload.category ?? ''
              ];
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
