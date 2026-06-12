'use client';

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
} from 'recharts';
import type { FederalTaxResult } from '@/lib/tax/types';
import { formatCurrency } from '@/lib/format';

/**
 * Horizontal stacked bar showing how ordinary taxable income fills the
 * federal brackets, with the preferential (LTCG/qualified dividend) stack
 * shown on a second row.
 */

const BRACKET_COLORS: Record<string, string> = {
  '0.1': '#134e4a',   // teal-900
  '0.12': '#115e59',  // teal-800
  '0.22': '#0f766e',  // teal-700
  '0.24': '#0d9488',  // teal-600
  '0.32': '#14b8a6',  // teal-500
  '0.35': '#2dd4bf',  // teal-400
  '0.37': '#5eead4',  // teal-300
};

const CG_COLORS: Record<string, string> = {
  '0': '#1e3a8a',     // blue-900
  '0.15': '#1d4ed8',  // blue-700
  '0.2': '#60a5fa',   // blue-400
};

interface ChartRow {
  name: string;
  [key: string]: string | number;
}

interface SegmentMeta {
  key: string;
  label: string;
  color: string;
  amount: number;
  tax: number;
}

export default function BracketFillChart({ federal }: { federal: FederalTaxResult }) {
  const ordinarySegments: SegmentMeta[] = federal.ordinaryBracketFills
    .filter(f => f.amountInBracket > 0)
    .map(f => ({
      key: `ord_${f.rate}`,
      label: `${Math.round(f.rate * 100)}% bracket`,
      color: BRACKET_COLORS[String(f.rate)] ?? '#2dd4bf',
      amount: f.amountInBracket,
      tax: f.taxInBracket,
    }));

  const cgSegments: SegmentMeta[] = federal.capitalGainsBracketFills
    .filter(f => f.amountInBracket > 0)
    .map(f => ({
      key: `cg_${f.rate}`,
      label: `${Math.round(f.rate * 100)}% LTCG/QDI`,
      color: CG_COLORS[String(f.rate)] ?? '#60a5fa',
      amount: f.amountInBracket,
      tax: f.taxInBracket,
    }));

  const rows: ChartRow[] = [];
  const ordinaryRow: ChartRow = { name: 'Ordinary' };
  for (const s of ordinarySegments) ordinaryRow[s.key] = s.amount;
  rows.push(ordinaryRow);

  if (cgSegments.length > 0) {
    const cgRow: ChartRow = { name: 'LTCG/QDI' };
    for (const s of cgSegments) cgRow[s.key] = s.amount;
    rows.push(cgRow);
  }

  const allSegments = [...ordinarySegments, ...cgSegments];
  const segmentByKey = new Map(allSegments.map(s => [s.key, s]));

  if (federal.taxableIncome <= 0) {
    return (
      <div className="h-24 flex items-center justify-center text-sm text-foreground-muted">
        No taxable income to chart.
      </div>
    );
  }

  return (
    <div>
      <div style={{ height: rows.length > 1 ? 150 : 100 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
            <XAxis
              type="number"
              tick={{ fill: '#64748b', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}
              tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
              stroke="#243049"
            />
            <YAxis
              type="category"
              dataKey="name"
              width={76}
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              stroke="#243049"
            />
            <Tooltip
              cursor={{ fill: 'rgba(45,212,191,0.06)' }}
              content={({ payload }) => {
                if (!payload || payload.length === 0) return null;
                return (
                  <div className="bg-surface-elevated border border-border rounded-md p-3 text-xs space-y-1">
                    {payload.map(p => {
                      const meta = segmentByKey.get(String(p.dataKey));
                      if (!meta) return null;
                      return (
                        <div key={String(p.dataKey)} className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-sm" style={{ background: meta.color }} />
                          <span className="text-foreground-secondary">{meta.label}:</span>
                          <span className="font-mono text-foreground">{formatCurrency(meta.amount)}</span>
                          <span className="text-foreground-muted">→ {formatCurrency(meta.tax)} tax</span>
                        </div>
                      );
                    })}
                  </div>
                );
              }}
            />
            {allSegments.map(s => (
              <Bar key={s.key} dataKey={s.key} stackId="fill" isAnimationActive={false}>
                {rows.map((_, i) => (
                  <Cell key={i} fill={s.color} />
                ))}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
        {allSegments.map(s => (
          <div key={s.key} className="flex items-center gap-1.5 text-xs text-foreground-secondary">
            <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: s.color }} />
            {s.label}
            <span className="font-mono text-foreground-muted">{formatCurrency(s.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
