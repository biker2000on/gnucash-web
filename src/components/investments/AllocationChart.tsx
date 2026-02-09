'use client';

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { formatCurrency } from '@/lib/format';

interface AllocationChartProps {
  data: Array<{
    category: string;
    value: number;
    percent: number;
  }>;
}

const COLORS = ['#06b6d4', '#10b981', '#a855f7', '#f59e0b', '#f43f5e', '#3b82f6', '#84cc16', '#ec4899'];

export function AllocationChart({ data }: AllocationChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="bg-background-secondary rounded-lg p-6 border border-border">
        <h3 className="text-lg font-semibold text-foreground mb-4">Portfolio Allocation</h3>
        <p className="text-foreground-muted">No allocation data available</p>
      </div>
    );
  }

  return (
    <div className="bg-background-secondary rounded-lg p-6 border border-border">
      <h3 className="text-lg font-semibold text-foreground mb-4">Portfolio Allocation</h3>
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="category"
            cx="50%"
            cy="50%"
            outerRadius={100}
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
            formatter={(value, name, entry: any) => {
              const numValue = typeof value === 'number' ? value : 0;
              return [
                `${formatCurrency(numValue)} (${(entry.payload.percent ?? 0).toFixed(1)}%)`,
                entry.payload.category
              ];
            }}
          />
          <Legend
            formatter={(value, entry: any) => (
              <span style={{ color: '#d4d4d4' }}>
                {value} ({entry.payload.percent.toFixed(1)}%)
              </span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
