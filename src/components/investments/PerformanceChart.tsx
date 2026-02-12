'use client';

import { useState, useMemo, useContext, useEffect, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, AreaChart, Area, ReferenceLine, Legend,
} from 'recharts';
import { formatCurrency } from '@/lib/format';
import { ExpandedContext } from '@/components/charts/ExpandableChart';
import { computeZeroOffset, CHART_COLORS, GRADIENT_FILL_OPACITY } from '@/lib/chart-utils';
import { ChartSettingsPanel } from './ChartSettingsPanel';

interface IndexDataPoint {
  date: string;
  value: number;
  percentChange: number;
}

interface IndicesData {
  sp500: IndexDataPoint[];
  djia: IndexDataPoint[];
}

export interface ChartDefaults {
  sp500Enabled: boolean;
  djiaEnabled: boolean;
  defaultPeriod: string;
  defaultMode: 'dollar' | 'percent';
}

interface PerformanceChartProps {
  data: Array<{
    date: string;
    value: number;
  }>;
  indices?: IndicesData;
  chartDefaults?: ChartDefaults;
}

type Period = '1M' | '3M' | '6M' | '1Y' | '3Y' | '5Y' | 'ALL';

const INDEX_COLORS = {
  sp500: '#f97316', // orange
  djia: '#a855f7',  // purple
  portfolio: '#06b6d4', // cyan
};

export function PerformanceChart({ data, indices, chartDefaults }: PerformanceChartProps) {
  const expanded = useContext(ExpandedContext);

  const initialPeriod = (chartDefaults?.defaultPeriod as Period) || '1Y';
  const initialMode = chartDefaults?.defaultMode === 'percent' ? 'percentChange' : 'value';

  const [period, setPeriod] = useState<Period>(initialPeriod);
  const [chartMode, setChartMode] = useState<'value' | 'percentChange'>(initialMode);
  const [showSP500, setShowSP500] = useState(chartDefaults?.sp500Enabled ?? false);
  const [showDJIA, setShowDJIA] = useState(chartDefaults?.djiaEnabled ?? false);
  const [currentDefaults, setCurrentDefaults] = useState<ChartDefaults | undefined>(chartDefaults);
  const [defaultsLoaded, setDefaultsLoaded] = useState(!!chartDefaults);

  // Self-load chart defaults from API if not provided via props
  useEffect(() => {
    if (chartDefaults || defaultsLoaded) return;
    let cancelled = false;
    async function loadDefaults() {
      try {
        const res = await fetch('/api/user/preferences?key=chart_defaults');
        if (!res.ok) return;
        const data: ChartDefaults = await res.json();
        if (cancelled) return;
        setCurrentDefaults(data);
        setPeriod((data.defaultPeriod as Period) || '1Y');
        setChartMode(data.defaultMode === 'percent' ? 'percentChange' : 'value');
        setShowSP500(data.sp500Enabled);
        setShowDJIA(data.djiaEnabled);
      } catch {
        // Ignore - use defaults
      } finally {
        if (!cancelled) setDefaultsLoaded(true);
      }
    }
    loadDefaults();
    return () => { cancelled = true; };
  }, [chartDefaults, defaultsLoaded]);

  // Sync with chartDefaults prop when it changes (e.g., after settings save)
  useEffect(() => {
    if (chartDefaults) {
      setCurrentDefaults(chartDefaults);
    }
  }, [chartDefaults]);

  const handleSettingsChange = useCallback((newDefaults: ChartDefaults) => {
    setCurrentDefaults(newDefaults);
    setShowSP500(newDefaults.sp500Enabled);
    setShowDJIA(newDefaults.djiaEnabled);
    setPeriod((newDefaults.defaultPeriod as Period) || '1Y');
    setChartMode(newDefaults.defaultMode === 'percent' ? 'percentChange' : 'value');
  }, []);

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

  // Build merged data for % mode with index lines
  const displayData = useMemo(() => {
    if (filteredData.length === 0) return [];

    if (chartMode === 'value') {
      return filteredData;
    }

    // Percent change mode
    const firstValue = filteredData[0].value;
    if (firstValue === 0) return filteredData;

    // Build a map of index data by date for fast lookup
    const sp500Map = new Map<string, number>();
    const djiaMap = new Map<string, number>();

    if (indices?.sp500) {
      for (const pt of indices.sp500) {
        sp500Map.set(pt.date, pt.percentChange);
      }
    }
    if (indices?.djia) {
      for (const pt of indices.djia) {
        djiaMap.set(pt.date, pt.percentChange);
      }
    }

    // Filter index data to the same period cutoff
    const cutoffDateStr = filteredData[0]?.date;

    // Find base values for indices at the start of filtered period
    let sp500Base: number | null = null;
    let djiaBase: number | null = null;

    if (indices?.sp500) {
      for (const pt of indices.sp500) {
        if (pt.date >= cutoffDateStr) {
          sp500Base = pt.value;
          break;
        }
      }
    }
    if (indices?.djia) {
      for (const pt of indices.djia) {
        if (pt.date >= cutoffDateStr) {
          djiaBase = pt.value;
          break;
        }
      }
    }

    // Recalculate percent change from the filtered period start
    const sp500PctMap = new Map<string, number>();
    const djiaPctMap = new Map<string, number>();

    if (sp500Base && indices?.sp500) {
      for (const pt of indices.sp500) {
        if (pt.date >= cutoffDateStr) {
          sp500PctMap.set(pt.date, Math.round(((pt.value - sp500Base) / sp500Base) * 10000) / 100);
        }
      }
    }
    if (djiaBase && indices?.djia) {
      for (const pt of indices.djia) {
        if (pt.date >= cutoffDateStr) {
          djiaPctMap.set(pt.date, Math.round(((pt.value - djiaBase) / djiaBase) * 10000) / 100);
        }
      }
    }

    return filteredData.map(point => ({
      ...point,
      value: ((point.value - firstValue) / firstValue) * 100,
      sp500: sp500PctMap.get(point.date) ?? null,
      djia: djiaPctMap.get(point.date) ?? null,
    }));
  }, [filteredData, chartMode, indices]);

  const zeroOffset = useMemo(() => computeZeroOffset(displayData), [displayData]);

  const allPeriods: Period[] = ['1M', '3M', '6M', '1Y', '3Y', '5Y', 'ALL'];
  const periods = expanded ? allPeriods : (['1M', '6M', '1Y', 'ALL'] as Period[]);

  const isPercentMode = chartMode === 'percentChange';
  const hasIndices = indices && (indices.sp500.length > 0 || indices.djia.length > 0);

  if (!data || data.length === 0) {
    return (
      <div className="bg-background-secondary rounded-lg p-6 border border-border h-full">
        <h3 className="text-lg font-semibold text-foreground mb-4">Portfolio Performance</h3>
        <p className="text-foreground-muted">No performance data available</p>
      </div>
    );
  }

  const tooltipFormatter = (value: number | undefined, name?: string): [string, string] | [null, null] => {
    if (value === undefined || value === null) return [null, null];
    if (chartMode === 'percentChange') {
      const labels: Record<string, string> = {
        value: 'Portfolio',
        sp500: 'S&P 500',
        djia: 'DJIA',
      };
      return [`${Number(value).toFixed(2)}%`, labels[name || ''] || name || ''];
    }
    return [formatCurrency(value), 'Portfolio Value'];
  };

  return (
    <div className="bg-background-secondary rounded-lg p-6 border border-border h-full">
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold text-foreground shrink-0">Portfolio Performance</h3>
          <ChartSettingsPanel
            currentDefaults={currentDefaults}
            onSettingsChange={handleSettingsChange}
          />
        </div>
        <div className="flex items-center gap-1 flex-wrap justify-end">
          {/* Period selector */}
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

          {/* Dollar / Percent toggle */}
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

          {/* Index toggle buttons */}
          {hasIndices && (
            <div className="flex gap-1 border-l border-border pl-1 relative">
              <button
                onClick={() => isPercentMode && setShowSP500(!showSP500)}
                disabled={!isPercentMode}
                title={!isPercentMode ? 'Switch to % mode for index comparison' : (showSP500 ? 'Hide S&P 500' : 'Show S&P 500')}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  !isPercentMode
                    ? 'bg-background-tertiary text-foreground-muted opacity-50 cursor-not-allowed'
                    : showSP500
                      ? 'text-white'
                      : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                }`}
                style={isPercentMode && showSP500 ? { backgroundColor: INDEX_COLORS.sp500 } : undefined}
              >
                S&P
              </button>
              <button
                onClick={() => isPercentMode && setShowDJIA(!showDJIA)}
                disabled={!isPercentMode}
                title={!isPercentMode ? 'Switch to % mode for index comparison' : (showDJIA ? 'Hide DJIA' : 'Show DJIA')}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  !isPercentMode
                    ? 'bg-background-tertiary text-foreground-muted opacity-50 cursor-not-allowed'
                    : showDJIA
                      ? 'text-white'
                      : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                }`}
                style={isPercentMode && showDJIA ? { backgroundColor: INDEX_COLORS.djia } : undefined}
              >
                DJIA
              </button>
            </div>
          )}
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
              formatter={tooltipFormatter as never}
              labelFormatter={(date) => new Date(date).toLocaleDateString()}
            />
            <ReferenceLine y={0} stroke="#737373" strokeDasharray="3 3" />
            <Area
              type="monotone"
              dataKey="value"
              name="value"
              stroke="url(#perfStrokeGradient)"
              fill="url(#perfFillGradient)"
              fillOpacity={1}
              strokeWidth={2}
              dot={false}
              animationDuration={300}
              baseValue={0}
            />
            {showSP500 && (
              <Line
                type="monotone"
                dataKey="sp500"
                name="sp500"
                stroke={INDEX_COLORS.sp500}
                strokeWidth={1.5}
                dot={false}
                animationDuration={300}
                connectNulls
              />
            )}
            {showDJIA && (
              <Line
                type="monotone"
                dataKey="djia"
                name="djia"
                stroke={INDEX_COLORS.djia}
                strokeWidth={1.5}
                dot={false}
                animationDuration={300}
                connectNulls
              />
            )}
            {(showSP500 || showDJIA) && (
              <Legend
                verticalAlign="bottom"
                height={24}
                formatter={(val: string) => {
                  const labels: Record<string, string> = {
                    value: 'Portfolio',
                    sp500: 'S&P 500',
                    djia: 'DJIA',
                  };
                  return <span style={{ color: '#d4d4d4', fontSize: 11 }}>{labels[val] || val}</span>;
                }}
              />
            )}
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
