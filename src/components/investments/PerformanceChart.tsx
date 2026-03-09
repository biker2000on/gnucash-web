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
import type { ChartDefaults } from '@/lib/user-preferences';
import type { CashFlowPoint, IndicesData } from '@/types/investments';
import { calculateMoneyWeightedReturn, calculateTimeWeightedReturn } from '@/lib/investment-performance';

export type { ChartDefaults };

interface PerformanceChartProps {
  data: Array<{
    date: string;
    value: number;
  }>;
  cashFlows?: CashFlowPoint[];
  indices?: IndicesData;
  chartDefaults?: ChartDefaults;
  title?: string;
  returnMetric?: 'twr' | 'mwr';
  onReturnMetricChange?: (metric: 'twr' | 'mwr') => void;
}

type Period = '1M' | '3M' | '6M' | '1Y' | '3Y' | '5Y' | 'ALL';
type ChartMode = 'value' | 'twr' | 'mwr';

const INDEX_COLORS = {
  sp500: '#f97316',    // orange
  djia: '#a855f7',     // purple
  nasdaq: '#22c55e',   // green
  russell2000: '#ec4899', // pink
  portfolio: '#06b6d4', // cyan
};

export function PerformanceChart({
  data,
  cashFlows = [],
  indices,
  chartDefaults,
  title = 'Portfolio Performance',
  returnMetric = 'twr',
  onReturnMetricChange,
}: PerformanceChartProps) {
  const expanded = useContext(ExpandedContext);

  const initialPeriod = (chartDefaults?.defaultPeriod as Period) || '1Y';
  const resolveChartMode = useCallback((defaultMode?: ChartDefaults['defaultMode']): ChartMode => {
    if (defaultMode === 'twr' || defaultMode === 'mwr') {
      return defaultMode;
    }

    return 'value';
  }, []);

  const initialMode: ChartMode = resolveChartMode(chartDefaults?.defaultMode);

  const [period, setPeriod] = useState<Period>(initialPeriod);
  const [chartMode, setChartMode] = useState<ChartMode>(initialMode);
  const [showSP500, setShowSP500] = useState(chartDefaults?.sp500Enabled ?? false);
  const [showDJIA, setShowDJIA] = useState(chartDefaults?.djiaEnabled ?? false);
  const [showNasdaq, setShowNasdaq] = useState(chartDefaults?.nasdaqEnabled ?? false);
  const [showRussell2000, setShowRussell2000] = useState(chartDefaults?.russell2000Enabled ?? false);
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
        setChartMode(resolveChartMode(data.defaultMode));
        setShowSP500(data.sp500Enabled);
        setShowDJIA(data.djiaEnabled);
        setShowNasdaq(data.nasdaqEnabled);
        setShowRussell2000(data.russell2000Enabled);
      } catch {
        // Ignore - use defaults
      } finally {
        if (!cancelled) setDefaultsLoaded(true);
      }
    }
    loadDefaults();
    return () => { cancelled = true; };
  }, [chartDefaults, defaultsLoaded, resolveChartMode]);

  // Sync with chartDefaults prop when it changes (e.g., after settings save)
  useEffect(() => {
    if (chartDefaults) {
      setCurrentDefaults(chartDefaults);
    }
  }, [chartDefaults]);

  useEffect(() => {
    setChartMode((currentMode) => {
      if (currentMode === 'value') {
        return currentMode;
      }

      return returnMetric;
    });
  }, [returnMetric]);

  const handleSettingsChange = useCallback((newDefaults: ChartDefaults) => {
    setCurrentDefaults(newDefaults);
    setShowSP500(newDefaults.sp500Enabled);
    setShowDJIA(newDefaults.djiaEnabled);
    setShowNasdaq(newDefaults.nasdaqEnabled);
    setShowRussell2000(newDefaults.russell2000Enabled);
    setPeriod((newDefaults.defaultPeriod as Period) || '1Y');
    setChartMode(resolveChartMode(newDefaults.defaultMode));
  }, [resolveChartMode]);

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

  const filteredCashFlows = useMemo(() => {
    if (!cashFlows || cashFlows.length === 0) return [];
    if (filteredData.length === 0) return [];

    const startDate = filteredData[0]?.date;
    const endDate = filteredData[filteredData.length - 1]?.date;

    if (!startDate || !endDate) return [];

    return cashFlows.filter((cashFlow) => cashFlow.date >= startDate && cashFlow.date <= endDate);
  }, [cashFlows, filteredData]);

  const displayData = useMemo(() => {
    if (filteredData.length === 0) return [];

    if (chartMode === 'value') {
      return filteredData;
    }

    const portfolioSeries = filteredData.map((point, index) => {
      const historySlice = filteredData.slice(0, index + 1);
      const pointCashFlows = filteredCashFlows.filter((cashFlow) => cashFlow.date <= point.date);
      const value = chartMode === 'mwr'
        ? calculateMoneyWeightedReturn(historySlice, pointCashFlows)
        : calculateTimeWeightedReturn(historySlice, pointCashFlows);

      return {
        ...point,
        value: Number.isFinite(value) ? value : 0,
      };
    });

    if (chartMode === 'mwr') {
      return portfolioSeries;
    }

    const cutoffDateStr = filteredData[0]?.date;
    let sp500Base: number | null = null;
    let djiaBase: number | null = null;
    let nasdaqBase: number | null = null;
    let russell2000Base: number | null = null;

    if (indices?.sp500) {
      for (const pt of indices.sp500) {
        if (pt.date >= cutoffDateStr) { sp500Base = pt.value; break; }
      }
    }
    if (indices?.djia) {
      for (const pt of indices.djia) {
        if (pt.date >= cutoffDateStr) { djiaBase = pt.value; break; }
      }
    }
    if (indices?.nasdaq) {
      for (const pt of indices.nasdaq) {
        if (pt.date >= cutoffDateStr) { nasdaqBase = pt.value; break; }
      }
    }
    if (indices?.russell2000) {
      for (const pt of indices.russell2000) {
        if (pt.date >= cutoffDateStr) { russell2000Base = pt.value; break; }
      }
    }

    const sp500PctMap = new Map<string, number>();
    const djiaPctMap = new Map<string, number>();
    const nasdaqPctMap = new Map<string, number>();
    const russell2000PctMap = new Map<string, number>();

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
    if (nasdaqBase && indices?.nasdaq) {
      for (const pt of indices.nasdaq) {
        if (pt.date >= cutoffDateStr) {
          nasdaqPctMap.set(pt.date, Math.round(((pt.value - nasdaqBase) / nasdaqBase) * 10000) / 100);
        }
      }
    }
    if (russell2000Base && indices?.russell2000) {
      for (const pt of indices.russell2000) {
        if (pt.date >= cutoffDateStr) {
          russell2000PctMap.set(pt.date, Math.round(((pt.value - russell2000Base) / russell2000Base) * 10000) / 100);
        }
      }
    }

    return portfolioSeries.map(point => ({
      ...point,
      sp500: sp500PctMap.get(point.date) ?? null,
      djia: djiaPctMap.get(point.date) ?? null,
      nasdaq: nasdaqPctMap.get(point.date) ?? null,
      russell2000: russell2000PctMap.get(point.date) ?? null,
    }));
  }, [chartMode, filteredCashFlows, filteredData, indices]);

  const zeroOffset = useMemo(() => computeZeroOffset(displayData), [displayData]);

  const allPeriods: Period[] = ['1M', '3M', '6M', '1Y', '3Y', '5Y', 'ALL'];
  const periods = expanded ? allPeriods : (['1M', '6M', '1Y', 'ALL'] as Period[]);

  const isReturnMode = chartMode !== 'value';
  const isTimeWeightedMode = chartMode === 'twr';
  const hasIndices = indices && (indices.sp500.length > 0 || indices.djia.length > 0 || indices.nasdaq.length > 0 || indices.russell2000.length > 0);

  if (!data || data.length === 0) {
    return (
        <div className="bg-background-secondary rounded-lg p-6 border border-border h-full">
        <h3 className="text-lg font-semibold text-foreground mb-4">{title}</h3>
        <p className="text-foreground-muted">No performance data available</p>
      </div>
    );
  }

  const tooltipFormatter = (value: number | undefined, name?: string): [string, string] | [null, null] => {
    if (value === undefined || value === null) return [null, null];
    if (isReturnMode) {
      const labels: Record<string, string> = {
        value: chartMode === 'mwr' ? 'Portfolio MWR' : 'Portfolio TWR',
        sp500: 'S&P 500',
        djia: 'DJIA',
        nasdaq: 'NASDAQ',
        russell2000: 'Russell 2000',
      };
      return [`${Number(value).toFixed(2)}%`, labels[name || ''] || name || ''];
    }
    return [formatCurrency(value), 'Portfolio Value'];
  };

  return (
    <div className="bg-background-secondary rounded-lg p-6 border border-border h-full">
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold text-foreground shrink-0">{title}</h3>
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
                className={`px-2.5 py-1.5 min-h-[44px] min-w-[44px] text-xs rounded transition-colors flex items-center justify-center ${
                  period === p
                    ? 'bg-cyan-600 text-white'
                    : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Value / return metric toggle */}
          <div className="flex gap-1 border-l border-border pl-1">
            <button
              onClick={() => setChartMode('value')}
              title="Show dollar value"
              className={`px-2.5 py-1.5 min-h-[44px] min-w-[44px] text-xs rounded transition-colors flex items-center justify-center ${
                chartMode === 'value'
                  ? 'bg-cyan-600 text-white'
                  : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
              }`}
            >
              $
            </button>
            <button
              onClick={() => {
                setChartMode('twr');
                onReturnMetricChange?.('twr');
              }}
              title="Time-weighted return"
              className={`px-2.5 py-1.5 min-h-[44px] min-w-[44px] text-xs rounded transition-colors flex items-center justify-center ${
                chartMode === 'twr'
                  ? 'bg-cyan-600 text-white'
                  : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
              }`}
            >
              TWR
            </button>
            <button
              onClick={() => {
                setChartMode('mwr');
                onReturnMetricChange?.('mwr');
              }}
              title="Money-weighted return"
              className={`px-2.5 py-1.5 min-h-[44px] min-w-[44px] text-xs rounded transition-colors flex items-center justify-center ${
                chartMode === 'mwr'
                  ? 'bg-cyan-600 text-white'
                  : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
              }`}
            >
              MWR
            </button>
          </div>

          {/* Index toggle buttons */}
          {hasIndices && (
            <div className="flex gap-1 border-l border-border pl-1 relative">
              <button
                onClick={() => isTimeWeightedMode && setShowSP500(!showSP500)}
                disabled={!isTimeWeightedMode}
                title={!isTimeWeightedMode ? 'Switch to TWR mode for index comparison' : (showSP500 ? 'Hide S&P 500' : 'Show S&P 500')}
                className={`px-2.5 py-1.5 min-h-[44px] text-xs rounded transition-colors flex items-center justify-center ${
                  !isTimeWeightedMode
                    ? 'bg-background-tertiary text-foreground-muted opacity-50 cursor-not-allowed'
                    : showSP500
                      ? 'text-white'
                      : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                }`}
                style={isTimeWeightedMode && showSP500 ? { backgroundColor: INDEX_COLORS.sp500 } : undefined}
              >
                S&P
              </button>
              <button
                onClick={() => isTimeWeightedMode && setShowDJIA(!showDJIA)}
                disabled={!isTimeWeightedMode}
                title={!isTimeWeightedMode ? 'Switch to TWR mode for index comparison' : (showDJIA ? 'Hide DJIA' : 'Show DJIA')}
                className={`px-2.5 py-1.5 min-h-[44px] text-xs rounded transition-colors flex items-center justify-center ${
                  !isTimeWeightedMode
                    ? 'bg-background-tertiary text-foreground-muted opacity-50 cursor-not-allowed'
                    : showDJIA
                      ? 'text-white'
                      : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                }`}
                style={isTimeWeightedMode && showDJIA ? { backgroundColor: INDEX_COLORS.djia } : undefined}
              >
                DJIA
              </button>
              <button
                onClick={() => isTimeWeightedMode && setShowNasdaq(!showNasdaq)}
                disabled={!isTimeWeightedMode}
                title={!isTimeWeightedMode ? 'Switch to TWR mode for index comparison' : (showNasdaq ? 'Hide NASDAQ' : 'Show NASDAQ')}
                className={`px-2.5 py-1.5 min-h-[44px] text-xs rounded transition-colors flex items-center justify-center ${
                  !isTimeWeightedMode
                    ? 'bg-background-tertiary text-foreground-muted opacity-50 cursor-not-allowed'
                    : showNasdaq
                      ? 'text-white'
                      : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                }`}
                style={isTimeWeightedMode && showNasdaq ? { backgroundColor: INDEX_COLORS.nasdaq } : undefined}
              >
                NDQ
              </button>
              <button
                onClick={() => isTimeWeightedMode && setShowRussell2000(!showRussell2000)}
                disabled={!isTimeWeightedMode}
                title={!isTimeWeightedMode ? 'Switch to TWR mode for index comparison' : (showRussell2000 ? 'Hide Russell 2000' : 'Show Russell 2000')}
                className={`px-2.5 py-1.5 min-h-[44px] text-xs rounded transition-colors flex items-center justify-center ${
                  !isTimeWeightedMode
                    ? 'bg-background-tertiary text-foreground-muted opacity-50 cursor-not-allowed'
                    : showRussell2000
                      ? 'text-white'
                      : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                }`}
                style={isTimeWeightedMode && showRussell2000 ? { backgroundColor: INDEX_COLORS.russell2000 } : undefined}
              >
                R2K
              </button>
            </div>
          )}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={expanded ? "100%" : 300}>
        {isReturnMode ? (
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
            {showNasdaq && (
              <Line
                type="monotone"
                dataKey="nasdaq"
                name="nasdaq"
                stroke={INDEX_COLORS.nasdaq}
                strokeWidth={1.5}
                dot={false}
                animationDuration={300}
                connectNulls
              />
            )}
            {showRussell2000 && (
              <Line
                type="monotone"
                dataKey="russell2000"
                name="russell2000"
                stroke={INDEX_COLORS.russell2000}
                strokeWidth={1.5}
                dot={false}
                animationDuration={300}
                connectNulls
              />
            )}
            {(showSP500 || showDJIA || showNasdaq || showRussell2000) && (
              <Legend
                verticalAlign="bottom"
                height={24}
                formatter={(val: string) => {
                  const labels: Record<string, string> = {
                    value: chartMode === 'mwr' ? 'Portfolio MWR' : 'Portfolio TWR',
                    sp500: 'S&P 500',
                    djia: 'DJIA',
                    nasdaq: 'NASDAQ',
                    russell2000: 'Russell 2000',
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
