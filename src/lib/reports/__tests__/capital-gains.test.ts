/**
 * Capital-Gains (Form 8949 / Schedule D) — pure builder tests
 *
 * Covers short-vs-long-term bucketing by acquired/sold dates, proceeds/basis/
 * gain math, wash-sale adjustment application, Schedule D totals, 1099-B
 * match/mismatch/missing detection, and empty-year handling. All exercises the
 * pure core with hand-built inputs — no DB.
 */

import { describe, it, expect } from 'vitest';
import type { WashSaleResult } from '@/lib/lot-assignment';
import {
  computeTerm,
  isLongTerm,
  boxFor,
  buildForm8949Row,
  buildCapitalGainsReport,
  flagSuspectRows,
  reconcile1099B,
  parseBrokerCSV,
  type RealizedSaleInput,
  type BrokerRow,
} from '../capital-gains';

const sale = (over: Partial<RealizedSaleInput> = {}): RealizedSaleInput => ({
  accountGuid: 'acct-1',
  ticker: 'AAPL',
  shares: 10,
  dateAcquired: '2022-01-10T00:00:00.000Z',
  dateSold: '2024-03-15T00:00:00.000Z',
  proceeds: 1500,
  costBasis: 1000,
  ...over,
});

describe('term classification', () => {
  it('classifies more than one year as long-term', () => {
    expect(isLongTerm('2022-01-10', '2023-01-11')).toBe(true);
    expect(computeTerm('2022-01-10', '2024-03-15')).toBe('long_term');
  });

  it('classifies exactly one year (and less) as short-term', () => {
    // Sold exactly one year later is NOT "more than one year".
    expect(isLongTerm('2023-01-10', '2024-01-10')).toBe(false);
    expect(computeTerm('2023-06-01', '2024-01-10')).toBe('short_term');
  });
});

describe('box assignment defaults to not-reported', () => {
  it('uses Box C / F when basis not reported', () => {
    expect(boxFor('short_term', false)).toBe('C');
    expect(boxFor('long_term', false)).toBe('F');
  });
  it('upgrades to Box A / D when basis reported', () => {
    expect(boxFor('short_term', true)).toBe('A');
    expect(boxFor('long_term', true)).toBe('D');
  });
});

describe('buildForm8949Row math', () => {
  it('computes gain = proceeds - basis with no adjustment', () => {
    const row = buildForm8949Row(sale());
    expect(row.proceeds).toBe(1500);
    expect(row.costBasis).toBe(1000);
    expect(row.gain).toBe(500);
    expect(row.code).toBe('');
    expect(row.adjustment).toBe(0);
    expect(row.term).toBe('long_term');
    expect(row.box).toBe('F');
    expect(row.description).toBe('10 AAPL');
  });

  it('handles a loss and short-term classification', () => {
    const row = buildForm8949Row(
      sale({ dateAcquired: '2024-01-02', dateSold: '2024-06-01', proceeds: 800, costBasis: 1000 }),
    );
    expect(row.gain).toBe(-200);
    expect(row.term).toBe('short_term');
    expect(row.box).toBe('C');
  });
});

describe('wash-sale adjustment', () => {
  const washSales: WashSaleResult[] = [
    {
      splitGuid: 's1',
      sellDate: '2024-06-01T00:00:00.000Z',
      sellAccountGuid: 'acct-1',
      sellAccountName: 'Brokerage',
      ticker: 'AAPL',
      shares: 10,
      loss: -200, // stored negative
      washBuyDate: '2024-06-10T00:00:00.000Z',
      washBuyAccountGuid: 'acct-1',
      washBuyAccountName: 'Brokerage',
      daysApart: 9,
    },
  ];

  it('applies code W and disallows the loss on a matching loss sale', () => {
    const row = buildForm8949Row(
      sale({ dateAcquired: '2024-01-02', dateSold: '2024-06-01', proceeds: 800, costBasis: 1000 }),
      washSales,
    );
    expect(row.code).toBe('W');
    expect(row.adjustment).toBe(200);
    // -200 loss fully disallowed -> net 0
    expect(row.gain).toBe(0);
  });

  it('does not apply a wash adjustment to a gain', () => {
    const row = buildForm8949Row(
      sale({ dateSold: '2024-06-01', proceeds: 1500, costBasis: 1000 }),
      washSales,
    );
    expect(row.code).toBe('');
    expect(row.adjustment).toBe(0);
    expect(row.gain).toBe(500);
  });

  it('does not match a wash sale on a different day / ticker', () => {
    const row = buildForm8949Row(
      sale({ ticker: 'MSFT', dateAcquired: '2024-01-02', dateSold: '2024-06-01', proceeds: 800, costBasis: 1000 }),
      washSales,
    );
    expect(row.code).toBe('');
    expect(row.gain).toBe(-200);
  });
});

describe('buildCapitalGainsReport buckets + Schedule D totals', () => {
  it('splits ST vs LT into the right buckets and totals', () => {
    const sales: RealizedSaleInput[] = [
      // long-term gain
      sale({ dateAcquired: '2022-01-10', dateSold: '2024-03-15', proceeds: 1500, costBasis: 1000 }),
      // short-term loss
      sale({ ticker: 'MSFT', dateAcquired: '2024-01-02', dateSold: '2024-06-01', proceeds: 800, costBasis: 1000 }),
      // short-term reported basis -> Box A
      sale({ ticker: 'NVDA', dateAcquired: '2024-01-02', dateSold: '2024-09-01', proceeds: 2000, costBasis: 1200, basisReported: true }),
    ];
    const report = buildCapitalGainsReport(sales, [], 2024);

    const boxC = report.buckets.find(b => b.box === 'C')!;
    const boxF = report.buckets.find(b => b.box === 'F')!;
    const boxA = report.buckets.find(b => b.box === 'A')!;
    expect(boxC.rows).toHaveLength(1); // MSFT short-term, not reported
    expect(boxF.rows).toHaveLength(1); // AAPL long-term, not reported
    expect(boxA.rows).toHaveLength(1); // NVDA short-term, reported

    // Short-term totals: MSFT (-200) + NVDA (+800) = 600
    expect(report.scheduleD.shortTerm.gain).toBe(600);
    expect(report.scheduleD.shortTerm.proceeds).toBe(2800);
    expect(report.scheduleD.shortTerm.costBasis).toBe(2200);
    // Long-term: AAPL +500
    expect(report.scheduleD.longTerm.gain).toBe(500);
    expect(report.scheduleD.netShortTerm).toBe(600);
    expect(report.scheduleD.netLongTerm).toBe(500);
    expect(report.scheduleD.net).toBe(1100);
  });

  it('handles an empty year', () => {
    const report = buildCapitalGainsReport([], [], 2024);
    expect(report.rows).toHaveLength(0);
    expect(report.scheduleD.net).toBe(0);
    expect(report.buckets.every(b => b.rows.length === 0)).toBe(true);
    expect(report.warnings).toEqual([]);
  });
});

// Regression: a corrupt underlying transaction (FXAIX lot in the live book had
// a Sale-of-Assets split of -$4272.95 for 1.563 shares ≈ $2734/share vs ~$178
// for every sibling) silently produced a $4000 phantom gain on the tax form.
// The report now flags such rows instead of reporting them without warning.
// QA 2026-07-08.
describe('suspect-row flagging', () => {
  it('flags a sale whose per-share price is wildly off from same-security siblings', () => {
    const sales: RealizedSaleInput[] = [
      sale({ ticker: 'FXAIX', shares: 1.9, proceeds: 338.6, costBasis: 340, dateSold: '2024-05-22' }),
      sale({ ticker: 'FXAIX', shares: 1.86, proceeds: 331.7, costBasis: 340, dateSold: '2024-05-22' }),
      // Corrupt: 1.563 shares for $4272.95 -> ~$2734/share
      sale({ ticker: 'FXAIX', shares: 1.563, proceeds: 4272.95, costBasis: 272, dateSold: '2024-05-22' }),
    ];
    const report = buildCapitalGainsReport(sales, [], 2024);
    const flagged = report.rows.filter(r => r.suspect);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].proceeds).toBe(4272.95);
    expect(flagged[0].suspectReason).toMatch(/per share|\/share/i);
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toContain('FXAIX');
    // The sane siblings are not flagged.
    expect(report.rows.filter(r => !r.suspect)).toHaveLength(2);
  });

  it('does not flag a lone security with no sibling to compare against', () => {
    const warnings = flagSuspectRows([
      buildForm8949Row(sale({ ticker: 'SOLO', shares: 1, proceeds: 9999, costBasis: 100 })),
    ]);
    expect(warnings).toEqual([]);
  });

  it('does not flag normal same-security sales at similar prices', () => {
    const sales: RealizedSaleInput[] = [
      sale({ ticker: 'VTI', shares: 10, proceeds: 2500, costBasis: 2000, dateSold: '2024-04-01' }),
      sale({ ticker: 'VTI', shares: 5, proceeds: 1260, costBasis: 900, dateSold: '2024-07-01' }),
      sale({ ticker: 'VTI', shares: 8, proceeds: 2050, costBasis: 1600, dateSold: '2024-09-01' }),
    ];
    const report = buildCapitalGainsReport(sales, [], 2024);
    expect(report.rows.some(r => r.suspect)).toBe(false);
    expect(report.warnings).toEqual([]);
  });
});

describe('1099-B reconciliation', () => {
  const sales: RealizedSaleInput[] = [
    sale({ ticker: 'AAPL', dateSold: '2024-03-15', proceeds: 1500, costBasis: 1000 }),
    sale({ ticker: 'MSFT', dateSold: '2024-06-01', proceeds: 800, costBasis: 1000 }),
  ];

  it('matches by ticker + day + proceeds and flags basis mismatch', () => {
    const broker: BrokerRow[] = [
      { ticker: 'AAPL', dateSold: '2024-03-15', proceeds: 1500, basis: 1000 }, // clean match
      { ticker: 'MSFT', dateSold: '2024-06-01', proceeds: 800, basis: 950 },   // basis differs
    ];
    const result = reconcile1099B(sales, broker);
    expect(result.summary.matchedCount).toBe(2);
    expect(result.summary.mismatchCount).toBe(1);
    const msft = result.matched.find(m => m.ticker === 'MSFT')!;
    expect(msft.basisMismatch).toBe(true);
    expect(msft.basisDelta).toBe(50); // computed 1000 - broker 950
    expect(result.missingInBooks).toHaveLength(0);
    expect(result.missingInBroker).toHaveLength(0);
  });

  it('reports rows missing on either side', () => {
    const broker: BrokerRow[] = [
      { ticker: 'AAPL', dateSold: '2024-03-15', proceeds: 1500, basis: 1000 }, // matches
      { ticker: 'TSLA', dateSold: '2024-05-05', proceeds: 300, basis: 250 },   // not in books
    ];
    const result = reconcile1099B(sales, broker);
    expect(result.summary.matchedCount).toBe(1);
    expect(result.missingInBooks).toHaveLength(1);
    expect(result.missingInBooks[0].ticker).toBe('TSLA');
    expect(result.missingInBroker).toHaveLength(1);
    expect(result.missingInBroker[0].ticker).toBe('MSFT');
  });

  it('respects proceeds tolerance', () => {
    const broker: BrokerRow[] = [
      { ticker: 'AAPL', dateSold: '2024-03-15', proceeds: 1499.995, basis: 1000 },
    ];
    const result = reconcile1099B(sales, broker, 0.01);
    expect(result.summary.matchedCount).toBe(1);
  });
});

describe('parseBrokerCSV', () => {
  it('parses rows, skips header and blanks, strips $ signs', () => {
    const text = [
      'ticker,dateSold,proceeds,basis',
      'AAPL,2024-03-15,$1500.00,$1000.00',
      '',
      'MSFT,2024-06-01,800,950',
    ].join('\n');
    const rows = parseBrokerCSV(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ ticker: 'AAPL', dateSold: '2024-03-15', proceeds: 1500, basis: 1000 });
    expect(rows[1]).toEqual({ ticker: 'MSFT', dateSold: '2024-06-01', proceeds: 800, basis: 950 });
  });
});
