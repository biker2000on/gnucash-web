/**
 * Investment Benchmark Comparison Tests
 *
 * Covers the pure alignment + return-diff math: window resolution/filtering,
 * index forward-fill, rebase-to-100, index total return, alpha, coverage
 * flagging, and empty inputs.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveWindowStart,
  filterByWindow,
  forwardFillIndex,
  rebaseTo100,
  totalReturnOverWindow,
  buildPortfolioGrowthSeries,
  buildBenchmarkComparison,
} from '../investment-benchmark';

const REF = new Date('2026-07-08T00:00:00Z');

describe('resolveWindowStart', () => {
  it('resolves 1Y one calendar year back', () => {
    expect(resolveWindowStart('1Y', REF)).toBe('2025-07-08');
  });

  it('resolves 3Y and 5Y', () => {
    expect(resolveWindowStart('3Y', REF)).toBe('2023-07-08');
    expect(resolveWindowStart('5Y', REF)).toBe('2021-07-08');
  });

  it('resolves YTD to Jan 1 of the reference year', () => {
    expect(resolveWindowStart('YTD', REF)).toBe('2026-01-01');
  });

  it('returns null for max (no lower bound)', () => {
    expect(resolveWindowStart('max', REF)).toBeNull();
  });
});

describe('filterByWindow', () => {
  const points = [
    { date: '2024-01-01', value: 1 },
    { date: '2025-06-01', value: 2 },
    { date: '2026-03-01', value: 3 },
  ];

  it('keeps only points on/after the window start', () => {
    const out = filterByWindow(points, '1Y', REF); // start 2025-07-08
    expect(out.map((p) => p.date)).toEqual(['2026-03-01']);
  });

  it('YTD keeps points on/after Jan 1', () => {
    const out = filterByWindow(points, 'YTD', REF);
    expect(out.map((p) => p.date)).toEqual(['2026-03-01']);
  });

  it('max keeps everything, sorted ascending', () => {
    const shuffled = [points[2], points[0], points[1]];
    const out = filterByWindow(shuffled, 'max', REF);
    expect(out.map((p) => p.date)).toEqual(['2024-01-01', '2025-06-01', '2026-03-01']);
  });

  it('handles empty input', () => {
    expect(filterByWindow([], '1Y', REF)).toEqual([]);
  });
});

describe('forwardFillIndex', () => {
  it('forward-fills missing days with the most recent prior value', () => {
    const index = [
      { date: '2026-01-01', value: 100 },
      { date: '2026-01-03', value: 110 },
    ];
    const dates = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
    expect(forwardFillIndex(index, dates)).toEqual([100, 100, 110, 110]);
  });

  it('yields null for dates before the first index observation', () => {
    const index = [{ date: '2026-01-05', value: 100 }];
    const dates = ['2026-01-01', '2026-01-05', '2026-01-06'];
    expect(forwardFillIndex(index, dates)).toEqual([null, 100, 100]);
  });

  it('sorts unsorted index input before filling', () => {
    const index = [
      { date: '2026-01-03', value: 110 },
      { date: '2026-01-01', value: 100 },
    ];
    const dates = ['2026-01-02', '2026-01-03'];
    expect(forwardFillIndex(index, dates)).toEqual([100, 110]);
  });

  it('returns all-null when index history is empty', () => {
    expect(forwardFillIndex([], ['2026-01-01', '2026-01-02'])).toEqual([null, null]);
  });
});

describe('rebaseTo100', () => {
  it('rebases so the first non-null value becomes 100', () => {
    const out = rebaseTo100([200, 220, 180]) as number[];
    expect(out[0]).toBeCloseTo(100, 6);
    expect(out[1]).toBeCloseTo(110, 6);
    expect(out[2]).toBeCloseTo(90, 6);
  });

  it('preserves leading nulls and rebases from the first real value', () => {
    expect(rebaseTo100([null, 50, 75])).toEqual([null, 100, 150]);
  });

  it('returns all-null when there is no usable base', () => {
    expect(rebaseTo100([null, null])).toEqual([null, null]);
    expect(rebaseTo100([0, 0])).toEqual([null, null]);
  });
});

describe('totalReturnOverWindow', () => {
  it('computes percent return from first to last non-null value', () => {
    expect(totalReturnOverWindow([100, 105, 120])).toBeCloseTo(20, 6);
  });

  it('ignores leading/trailing nulls', () => {
    expect(totalReturnOverWindow([null, 100, 90, null])).toBeCloseTo(-10, 6);
  });

  it('returns 0 with fewer than two usable points', () => {
    expect(totalReturnOverWindow([null, 100, null])).toBe(0);
    expect(totalReturnOverWindow([])).toBe(0);
  });
});

describe('buildPortfolioGrowthSeries', () => {
  it('starts at 100 and ends at 100*(1+TWR) with no cash flows', () => {
    const history = [
      { date: '2026-01-01', value: 100 },
      { date: '2026-06-01', value: 110 },
    ];
    const series = buildPortfolioGrowthSeries(history, []);
    expect(series[0]).toBe(100);
    // No flows: TWR = 10%, growth = 110.
    expect(series[1]).toBeCloseTo(110, 6);
  });

  it('neutralizes a contribution so growth reflects return, not deposits', () => {
    // Value doubles from 100 to 200 but 100 of that is a deposit -> 0% return.
    const history = [
      { date: '2026-01-01', value: 100 },
      { date: '2026-02-01', value: 200 },
    ];
    const flows = [{ date: '2026-02-01', amount: 100 }];
    const series = buildPortfolioGrowthSeries(history, flows);
    expect(series[1]).toBeCloseTo(100, 6);
  });

  it('handles empty history', () => {
    expect(buildPortfolioGrowthSeries([], [])).toEqual([]);
  });
});

describe('buildBenchmarkComparison', () => {
  const history = [
    { date: '2025-07-10', value: 1000 },
    { date: '2025-10-01', value: 1100 },
    { date: '2026-01-01', value: 1150 },
    { date: '2026-07-01', value: 1300 },
  ];
  const indexHistory = [
    { date: '2025-07-10', value: 5000 },
    { date: '2025-10-01', value: 5200 },
    { date: '2026-01-01', value: 5300 },
    { date: '2026-07-01', value: 5750 },
  ];

  it('computes portfolio TWR, index return, and alpha over the window', () => {
    const result = buildBenchmarkComparison({
      history,
      cashFlows: [],
      indexHistory,
      indexSymbol: '^GSPC',
      indexName: 'S&P 500',
      window: '1Y',
      referenceDate: REF,
    });

    // No cash flows -> TWR is simple total growth 1000 -> 1300 = 30%.
    expect(result.portfolioReturn).toBeCloseTo(30, 6);
    // Index 5000 -> 5750 = 15%.
    expect(result.indexReturn).toBeCloseTo(15, 6);
    expect(result.alpha).toBeCloseTo(15, 6);
    expect(result.insufficientCoverage).toBe(false);
    expect(result.startDate).toBe('2025-07-10');
    expect(result.endDate).toBe('2026-07-01');

    // Both series rebased to 100 at the start, aligned on the same dates.
    expect(result.series[0]).toMatchObject({ portfolio: 100, index: 100 });
    expect(result.series).toHaveLength(4);
    expect(result.series[3].portfolio).toBeCloseTo(130, 6);
    expect(result.series[3].index).toBeCloseTo(115, 6);
  });

  it('excludes pre-window points via window filtering', () => {
    const withOld = [{ date: '2020-01-01', value: 500 }, ...history];
    const result = buildBenchmarkComparison({
      history: withOld,
      cashFlows: [],
      indexHistory,
      indexSymbol: '^GSPC',
      indexName: 'S&P 500',
      window: '1Y',
      referenceDate: REF,
    });
    // Old 2020 point dropped; window still starts at 2025-07-10.
    expect(result.startDate).toBe('2025-07-10');
    expect(result.series).toHaveLength(4);
    expect(result.portfolioReturn).toBeCloseTo(30, 6);
  });

  it('flags insufficient coverage when the index lacks window data', () => {
    const result = buildBenchmarkComparison({
      history,
      cashFlows: [],
      indexHistory: [], // no index prices at all
      indexSymbol: '^GSPC',
      indexName: 'S&P 500',
      window: '1Y',
      referenceDate: REF,
    });
    expect(result.insufficientCoverage).toBe(true);
    expect(result.indexReturn).toBe(0);
    expect(result.coverageNote).toContain('backfill');
    // Portfolio series still present even without index coverage.
    expect(result.series[0].portfolio).toBe(100);
    expect(result.series[0].index).toBeNull();
  });

  it('handles empty portfolio history', () => {
    const result = buildBenchmarkComparison({
      history: [],
      cashFlows: [],
      indexHistory,
      indexSymbol: '^GSPC',
      indexName: 'S&P 500',
      window: '1Y',
      referenceDate: REF,
    });
    expect(result.portfolioReturn).toBe(0);
    expect(result.indexReturn).toBe(0);
    expect(result.alpha).toBe(0);
    expect(result.series).toEqual([]);
    expect(result.startDate).toBeNull();
    expect(result.endDate).toBeNull();
    // With <2 dates, coverage isn't flagged (nothing to compare).
    expect(result.insufficientCoverage).toBe(false);
  });

  it('forward-fills a missing index day at the window edge', () => {
    // Index missing the final portfolio date (2026-07-01) -> forward-fill 5300.
    const gappyIndex = [
      { date: '2025-07-10', value: 5000 },
      { date: '2026-01-01', value: 5300 },
    ];
    const result = buildBenchmarkComparison({
      history,
      cashFlows: [],
      indexHistory: gappyIndex,
      indexSymbol: '^GSPC',
      indexName: 'S&P 500',
      window: '1Y',
      referenceDate: REF,
    });
    // Last aligned index value forward-filled to 5300 -> 6% total return.
    expect(result.indexReturn).toBeCloseTo(6, 6);
    expect(result.series[3].index).toBeCloseTo(106, 6);
    expect(result.insufficientCoverage).toBe(false);
  });
});
