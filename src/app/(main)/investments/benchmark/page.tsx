'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import ExpandableChart from '@/components/charts/ExpandableChart';
import { useToast } from '@/contexts/ToastContext';
import {
  BENCHMARK_INDEX_OPTIONS,
  DEFAULT_BENCHMARK_SYMBOL,
  type BenchmarkIndexOption,
  type BenchmarkWindow,
} from '@/lib/investment-benchmark-constants';
import type { BenchmarkComparison } from '@/lib/investment-benchmark';
import { BenchmarkChart } from './BenchmarkChart';

const WINDOWS: { key: BenchmarkWindow; label: string }[] = [
  { key: 'YTD', label: 'YTD' },
  { key: '1Y', label: '1Y' },
  { key: '3Y', label: '3Y' },
  { key: '5Y', label: '5Y' },
  { key: 'max', label: 'Max' },
];

interface BenchmarkResponse extends BenchmarkComparison {
  availableIndices: BenchmarkIndexOption[];
  backfillEndpoint: string;
}

function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export default function BenchmarkPage() {
  const { success, error: showError, warning } = useToast();

  const [indexSymbol, setIndexSymbol] = useState<string>(DEFAULT_BENCHMARK_SYMBOL);
  const [window, setWindow] = useState<BenchmarkWindow>('1Y');
  const [data, setData] = useState<BenchmarkResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [backfilling, setBackfilling] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ index: indexSymbol, window });
      const res = await fetch(`/api/investments/benchmark?${params}`);
      const json = await res.json();
      if (res.ok) {
        setData(json);
      } else {
        showError(json.error || 'Failed to load benchmark comparison');
      }
    } catch {
      showError('Failed to load benchmark comparison');
    } finally {
      setLoading(false);
    }
  }, [indexSymbol, window, showError]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleBackfill = useCallback(async () => {
    setBackfilling(true);
    try {
      const res = await fetch('/api/investments/backfill-indices', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        warning(json.error || 'Backfill requires admin access');
        return;
      }
      if (json.totalStored > 0) {
        success(`Backfilled ${json.totalStored} index prices`);
      } else {
        success('Index prices are already up to date');
      }
      await fetchData();
    } catch {
      showError('Failed to backfill index prices');
    } finally {
      setBackfilling(false);
    }
  }, [fetchData, success, warning, showError]);

  const indexOptions = data?.availableIndices ?? BENCHMARK_INDEX_OPTIONS;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Benchmark"
        subtitle="Your portfolio return vs a market index"
        toolbar={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* Index selector */}
            <div className="flex gap-1 overflow-x-auto [scrollbar-width:thin]">
              {indexOptions.map((opt) => (
                <button
                  key={opt.symbol}
                  onClick={() => setIndexSymbol(opt.symbol)}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    indexSymbol === opt.symbol
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                  }`}
                >
                  {opt.name}
                </button>
              ))}
            </div>

            {/* Window selector */}
            <div className="flex gap-1 border-l border-border pl-4">
              {WINDOWS.map((w) => (
                <button
                  key={w.key}
                  onClick={() => setWindow(w.key)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded transition-colors ${
                    window === w.key
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                  }`}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>
        }
      />

      {loading && !data ? (
        <div className="space-y-6">
          <StatGrid cols={3}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 sm:h-28 bg-background-tertiary rounded-lg animate-pulse" />
            ))}
          </StatGrid>
          <div className="h-80 bg-background-tertiary rounded-lg animate-pulse" />
        </div>
      ) : !data ? (
        <div className="bg-background-secondary rounded-lg p-8 border border-border text-center">
          <p className="text-foreground-secondary text-lg">No benchmark data available</p>
        </div>
      ) : (
        <>
          {/* Headline cards */}
          <StatGrid cols={3}>
            <StatCard
              label="Your return"
              value={formatPercent(data.portfolioReturn)}
              tone={data.portfolioReturn >= 0 ? 'positive' : 'negative'}
              sub="Time-weighted return"
            />
            <StatCard
              label={`${data.indexName} return`}
              value={data.insufficientCoverage ? '—' : formatPercent(data.indexReturn)}
              tone={data.indexReturn >= 0 ? 'positive' : 'negative'}
              sub={`${data.indexSymbol} total return`}
            />
            <StatCard
              label="Difference (alpha)"
              value={data.insufficientCoverage ? '—' : formatPercent(data.alpha)}
              tone={data.alpha >= 0 ? 'positive' : 'negative'}
              sub={
                data.insufficientCoverage
                  ? 'Needs index coverage'
                  : data.alpha >= 0
                    ? `Ahead of the ${data.indexName}`
                    : `Behind the ${data.indexName}`
              }
            />
          </StatGrid>

          {/* Coverage prompt */}
          {data.insufficientCoverage && (
            <div className="bg-warning/10 border border-warning/30 rounded-lg px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
              <p className="text-sm text-warning">
                {data.coverageNote ||
                  `No ${data.indexName} price data covers this window.`}
              </p>
              <button
                onClick={handleBackfill}
                disabled={backfilling}
                className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/30 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors shrink-0"
              >
                {backfilling ? 'Backfilling…' : 'Backfill index prices'}
              </button>
            </div>
          )}

          {/* Comparison chart */}
          <ExpandableChart title={`Growth of 100 — Portfolio vs ${data.indexName}`}>
            <BenchmarkChart series={data.series} indexName={data.indexName} />
          </ExpandableChart>

          <p className="text-xs text-foreground-muted">
            Both lines start at 100 on{' '}
            {data.startDate ? new Date(data.startDate).toLocaleDateString() : 'the window start'}.
            Your line is the time-weighted return (contributions and withdrawals removed); the index
            line is the price rebased to 100.
          </p>
        </>
      )}
    </div>
  );
}
