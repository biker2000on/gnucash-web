'use client';

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import type { BreakevenResult } from '@/lib/tax/filing-comparison';
import { formatCurrency } from '@/lib/format';

/**
 * Breakeven sweep chart: MFJ vs MFS combined total tax across the swept
 * variable, with the household's current position and any crossover points
 * marked. Follows the tool-chart conventions of BracketFillChart (recharts,
 * DESIGN.md palette, JetBrains Mono tick labels).
 */

const MFJ_COLOR = '#2dd4bf'; // teal-400 (--primary)
const MFS_COLOR = '#60a5fa'; // blue-400 (--secondary)
const CURRENT_COLOR = '#fbbf24'; // amber (--warning)
const CROSSOVER_COLOR = '#f87171'; // --negative

function formatX(value: number, isPercent: boolean): string {
  if (isPercent) return `${Math.round(value)}%`;
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(0)}k`;
  return `$${value.toFixed(0)}`;
}

export default function BreakevenChart({
  sweep,
  xLabel,
}: {
  sweep: BreakevenResult;
  xLabel: string;
}) {
  const isPercent = sweep.variable === 'deductionsSelfPct';
  if (sweep.points.length < 2) {
    return (
      <div className="h-24 flex items-center justify-center text-sm text-foreground-muted">
        Not enough points to chart.
      </div>
    );
  }

  return (
    <div>
      <div style={{ height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={sweep.points} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
            <XAxis
              dataKey="x"
              type="number"
              domain={['dataMin', 'dataMax']}
              tick={{ fill: '#64748b', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}
              tickFormatter={(v: number) => formatX(v, isPercent)}
              stroke="#243049"
            />
            <YAxis
              tick={{ fill: '#64748b', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}
              tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
              stroke="#243049"
              width={52}
            />
            <Tooltip
              cursor={{ stroke: '#2d3d5a', strokeWidth: 1 }}
              content={({ payload, label }) => {
                if (!payload || payload.length === 0) return null;
                const point = sweep.points.find(p => p.x === label);
                if (!point) return null;
                const diff = point.mfsTotal - point.mfjTotal;
                return (
                  <div className="bg-surface-elevated border border-border rounded-md p-3 text-xs space-y-1">
                    <div className="text-foreground-secondary">
                      {xLabel}: <span className="font-mono text-foreground">{formatX(point.x, isPercent)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-sm" style={{ background: MFJ_COLOR }} />
                      <span className="text-foreground-secondary">Joint:</span>
                      <span className="font-mono text-foreground">{formatCurrency(point.mfjTotal)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-sm" style={{ background: MFS_COLOR }} />
                      <span className="text-foreground-secondary">Separate:</span>
                      <span className="font-mono text-foreground">{formatCurrency(point.mfsTotal)}</span>
                    </div>
                    <div className="text-foreground-muted">
                      {diff >= 0 ? 'Joint saves ' : 'Separate saves '}
                      <span className="font-mono">{formatCurrency(Math.abs(diff))}</span>
                    </div>
                  </div>
                );
              }}
            />
            <ReferenceLine
              x={sweep.currentX}
              stroke={CURRENT_COLOR}
              strokeDasharray="4 3"
              label={{ value: 'now', fill: CURRENT_COLOR, fontSize: 10, position: 'top' }}
            />
            {sweep.crossovers.map(x => (
              <ReferenceLine
                key={x}
                x={x}
                stroke={CROSSOVER_COLOR}
                strokeDasharray="2 3"
                label={{ value: 'breakeven', fill: CROSSOVER_COLOR, fontSize: 10, position: 'insideTopRight' }}
              />
            ))}
            <Line
              type="monotone"
              dataKey="mfjTotal"
              stroke={MFJ_COLOR}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="mfsTotal"
              stroke={MFS_COLOR}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-foreground-secondary">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: MFJ_COLOR }} />
          Joint total tax
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: MFS_COLOR }} />
          Separate combined total tax
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: CURRENT_COLOR }} />
          Current position
        </span>
        {sweep.crossovers.length > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: CROSSOVER_COLOR }} />
            Breakeven
          </span>
        )}
      </div>
    </div>
  );
}
