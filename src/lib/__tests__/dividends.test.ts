import { describe, it, expect } from 'vitest';

// dividends.ts imports the prisma singleton for its DB loader; the pure
// aggregators under test never touch it, so no mock is required. (Importing
// the module does not instantiate a connection.)
import {
    totalDividendsForYear,
    trailingTwelveMonthTotal,
    perYearTotals,
    perSecurityDividends,
    computeYieldOnCost,
    computeCurrentYield,
    monthlyDividendSeries,
    detectSecurityCadence,
    projectForwardCalendar,
    summarizeDividends,
    ttmWindowStart,
    type DividendPayment,
    type SecurityValuation,
} from '../dividends';

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const AS_OF = new Date('2026-01-01T00:00:00Z');

function pay(
    date: string,
    amount: number,
    ticker: string,
    commodityGuid: string | null = `guid-${ticker}`,
): DividendPayment {
    return {
        date: new Date(date + 'T12:00:00Z'),
        amount,
        ticker,
        commodityGuid,
        incomeAccountGuid: 'income-guid',
        incomeAccountName: 'Income:Investment:Dividend Income',
        investmentAccountGuid: `acct-${ticker}`,
        investmentAccountName: `Assets:Investments:${ticker}`,
        description: `${ticker} Dividend`,
    };
}

/** Quarterly payer: 4 payments/year on ~91-day cadence. */
function quarterly(ticker: string, startYear: number, years: number, amount: number): DividendPayment[] {
    const out: DividendPayment[] = [];
    for (let y = 0; y < years; y++) {
        for (const m of ['03', '06', '09', '12']) {
            out.push(pay(`${startYear + y}-${m}-15`, amount, ticker));
        }
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Per-year + TTM totals                                               */
/* ------------------------------------------------------------------ */

describe('yearly and trailing-12-month totals', () => {
    const payments = [
        pay('2024-03-15', 100, 'VTI'),
        pay('2024-09-15', 100, 'VTI'),
        pay('2025-03-15', 120, 'VTI'),
        pay('2025-06-15', 120, 'VTI'),
        pay('2025-09-15', 120, 'VTI'),
        pay('2025-12-15', 130, 'VTI'),
    ];

    it('sums dividends per calendar year', () => {
        expect(totalDividendsForYear(payments, 2024)).toBe(200);
        expect(totalDividendsForYear(payments, 2025)).toBe(490);
        expect(totalDividendsForYear(payments, 2023)).toBe(0);
    });

    it('groups per-year totals ascending', () => {
        expect(perYearTotals(payments)).toEqual([
            { year: 2024, amount: 200 },
            { year: 2025, amount: 490 },
        ]);
    });

    it('sums the trailing 12 months ending at asOf', () => {
        // window is (2025-01-01, 2026-01-01]: all four 2025 payments.
        expect(trailingTwelveMonthTotal(payments, AS_OF)).toBe(490);
    });

    it('excludes payments exactly at the window start (exclusive lower bound)', () => {
        const start = ttmWindowStart(AS_OF);
        const edge: DividendPayment = { ...pay('2025-01-01', 50, 'X'), date: start };
        expect(trailingTwelveMonthTotal(edge ? [edge] : [], AS_OF)).toBe(0);
        // A payment one second later is included.
        const inside: DividendPayment = { ...edge, date: new Date(start.getTime() + 1000) };
        expect(trailingTwelveMonthTotal([inside], AS_OF)).toBe(50);
    });
});

/* ------------------------------------------------------------------ */
/* Yield math                                                          */
/* ------------------------------------------------------------------ */

describe('yield-on-cost and current-yield math', () => {
    it('computes yield-on-cost as ttm / cost basis', () => {
        expect(computeYieldOnCost(200, 10000)).toBeCloseTo(2, 6);
    });

    it('computes current yield as ttm / market value', () => {
        expect(computeCurrentYield(200, 8000)).toBeCloseTo(2.5, 6);
    });

    it('returns null when the denominator is zero or negative', () => {
        expect(computeYieldOnCost(200, 0)).toBeNull();
        expect(computeCurrentYield(200, -5)).toBeNull();
    });

    it('attaches yields to per-security rows from a valuation map', () => {
        const payments = quarterly('VTI', 2025, 1, 100); // 400 in 2025, all in TTM
        const valuations = new Map<string, SecurityValuation>([
            ['c:guid-VTI', { commodityGuid: 'guid-VTI', ticker: 'VTI', costBasis: 10000, marketValue: 20000 }],
        ]);
        const [row] = perSecurityDividends(payments, { asOf: AS_OF, valuations });
        expect(row.ticker).toBe('VTI');
        expect(row.ttmIncome).toBe(400);
        expect(row.yieldOnCost).toBeCloseTo(4, 6);   // 400 / 10000
        expect(row.currentYield).toBeCloseTo(2, 6);  // 400 / 20000
        expect(row.costBasis).toBe(10000);
        expect(row.lastPaymentDate).toBe('2025-12-15');
    });

    it('leaves yields null when a security has no valuation', () => {
        const [row] = perSecurityDividends([pay('2025-06-15', 50, 'CASHONLY', null)], {
            asOf: AS_OF,
        });
        expect(row.yieldOnCost).toBeNull();
        expect(row.currentYield).toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/* Monthly series bucketing                                            */
/* ------------------------------------------------------------------ */

describe('monthly income series bucketing', () => {
    it('produces a continuous run of month buckets with zero-fill', () => {
        const payments = [
            pay('2025-11-15', 100, 'VTI'),
            pay('2025-11-20', 25, 'VOO'), // same month, different security -> summed
            pay('2025-12-15', 130, 'VTI'),
        ];
        const series = monthlyDividendSeries(payments, { asOf: AS_OF, months: 3 });
        // asOf 2026-01 -> months are 2025-11, 2025-12, 2026-01
        expect(series.map(m => m.month)).toEqual(['2025-11', '2025-12', '2026-01']);
        expect(series).toEqual([
            { month: '2025-11', amount: 125 },
            { month: '2025-12', amount: 130 },
            { month: '2026-01', amount: 0 },
        ]);
    });

    it('ignores payments outside the seeded window', () => {
        const payments = [pay('2020-01-15', 999, 'OLD'), pay('2025-12-15', 10, 'VTI')];
        const series = monthlyDividendSeries(payments, { asOf: AS_OF, months: 2 });
        const total = series.reduce((s, m) => s + m.amount, 0);
        expect(total).toBe(10);
    });
});

/* ------------------------------------------------------------------ */
/* Forward projection                                                  */
/* ------------------------------------------------------------------ */

describe('forward projection from a regular quarterly payer', () => {
    it('detects a quarterly cadence', () => {
        const payments = quarterly('VTI', 2024, 2, 100); // 8 quarterly payments
        const detected = detectSecurityCadence(payments);
        expect(detected?.cadence).toBe('quarterly');
        expect(detected!.medianIntervalDays).toBeGreaterThanOrEqual(78);
        expect(detected!.medianIntervalDays).toBeLessThanOrEqual(104);
    });

    it('projects ~4 payments over the next 12 months', () => {
        const payments = quarterly('VTI', 2024, 2, 100); // last payment 2025-12-15
        const { calendar, projections } = projectForwardCalendar(payments, {
            asOf: AS_OF,
            months: 12,
        });
        const vtiDates = calendar.filter(c => c.ticker === 'VTI');
        // Quarterly cadence across a 12-month horizon yields ~4 payments.
        expect(vtiDates.length).toBeGreaterThanOrEqual(3);
        expect(vtiDates.length).toBeLessThanOrEqual(5);
        // All projected dates are in the future.
        for (const c of vtiDates) expect(c.date > '2026-01-01').toBe(true);
        // Estimated amount carries the most recent payment amount.
        expect(vtiDates[0].estimatedAmount).toBe(100);
        expect(projections.find(p => p.ticker === 'VTI')?.projected).toBe(true);
    });
});

describe('irregular and sparse payers are excluded from projection', () => {
    it('flags a one-off / single-payment security as not projected', () => {
        const payments = [pay('2025-06-15', 500, 'ONEOFF')];
        const { calendar, projections } = projectForwardCalendar(payments, { asOf: AS_OF });
        expect(calendar.find(c => c.ticker === 'ONEOFF')).toBeUndefined();
        const proj = projections.find(p => p.ticker === 'ONEOFF');
        expect(proj?.projected).toBe(false);
        expect(proj?.reason).toBe('too few payments');
    });

    it('flags an irregular-cadence security as not projected', () => {
        // Enough payments, but wildly inconsistent intervals -> no cadence band.
        const payments = [
            pay('2024-01-15', 10, 'RAND'),
            pay('2024-02-01', 10, 'RAND'),
            pay('2024-08-01', 10, 'RAND'),
            pay('2025-01-15', 10, 'RAND'),
            pay('2025-01-20', 10, 'RAND'),
        ];
        const { calendar, projections } = projectForwardCalendar(payments, { asOf: AS_OF });
        expect(calendar.find(c => c.ticker === 'RAND')).toBeUndefined();
        expect(projections.find(p => p.ticker === 'RAND')?.projected).toBe(false);
    });

    it('detectSecurityCadence returns null for fewer than the minimum payments', () => {
        expect(detectSecurityCadence([pay('2025-06-15', 10, 'X')])).toBeNull();
    });

    // Regression: a security that stopped paying years ago (e.g. VTSAX, last
    // dividend 2018 in the live book) was still projected forward, inventing
    // thousands in income that will never arrive. QA 2026-07-08.
    it('does not project a security whose last payment predates the active window', () => {
        // Regular quarterly cadence, but the whole series is 2016-2017 — stale.
        const payments = quarterly('STALE', 2016, 2, 100);
        const { calendar, projections } = projectForwardCalendar(payments, { asOf: AS_OF });
        expect(calendar.find(c => c.ticker === 'STALE')).toBeUndefined();
        const proj = projections.find(p => p.ticker === 'STALE');
        expect(proj?.projected).toBe(false);
        expect(proj?.reason).toBe('no recent payments');
    });

    // Regression: projection anchored to the single most-recent payment
    // overshot trailing income ~3x for growing DRIP positions. It should now
    // track the trailing-12-month total instead. QA 2026-07-08.
    it('anchors projected next-12-month income to trailing income, not the latest payment', () => {
        // Growing quarterly payer: last 4 payments (trailing 12mo) sum to 520,
        // with the most recent being the largest at 160.
        const payments = [
            pay('2025-03-15', 100, 'GROW'),
            pay('2025-06-15', 120, 'GROW'),
            pay('2025-09-15', 140, 'GROW'),
            pay('2025-12-15', 160, 'GROW'),
        ];
        const { calendar } = projectForwardCalendar(payments, { asOf: AS_OF, months: 12 });
        const grow = calendar.filter(c => c.ticker === 'GROW');
        const projectedTotal = grow.reduce((s, c) => s + c.estimatedAmount, 0);
        // Trailing 12mo = 520 (all four). Latest-payment-x4 would have been 640.
        // Projection tracks trailing income, well under the naive overshoot.
        expect(projectedTotal).toBeLessThanOrEqual(560);
        expect(projectedTotal).toBeGreaterThanOrEqual(480);
        // Each projected payment reflects trailing/4, not the 160 latest.
        expect(grow[0].estimatedAmount).toBeCloseTo(520 / 4, 5);
    });
});

/* ------------------------------------------------------------------ */
/* Empty data                                                          */
/* ------------------------------------------------------------------ */

describe('empty data', () => {
    it('returns zeroed aggregates with no payments', () => {
        expect(totalDividendsForYear([], 2025)).toBe(0);
        expect(trailingTwelveMonthTotal([], AS_OF)).toBe(0);
        expect(perYearTotals([])).toEqual([]);
        expect(perSecurityDividends([], { asOf: AS_OF })).toEqual([]);
        expect(projectForwardCalendar([], { asOf: AS_OF })).toEqual({
            calendar: [],
            projections: [],
        });
    });

    it('summarizeDividends produces a well-formed empty summary', () => {
        const summary = summarizeDividends([], { asOf: AS_OF, monthlyMonths: 6 });
        expect(summary.ttmTotal).toBe(0);
        expect(summary.projectedNext12mo).toBe(0);
        expect(summary.portfolioYield).toBeNull();
        expect(summary.perSecurity).toEqual([]);
        expect(summary.monthly).toHaveLength(6);
        expect(summary.monthly.every(m => m.amount === 0)).toBe(true);
    });
});

/* ------------------------------------------------------------------ */
/* Full summary                                                        */
/* ------------------------------------------------------------------ */

describe('summarizeDividends end to end', () => {
    it('combines totals, yields, series and projection', () => {
        const payments = [
            ...quarterly('VTI', 2024, 2, 100), // 8 payments, quarterly
            pay('2025-06-15', 500, 'ONEOFF', null), // irregular one-off
        ];
        const valuations = new Map<string, SecurityValuation>([
            ['c:guid-VTI', { commodityGuid: 'guid-VTI', ticker: 'VTI', costBasis: 5000, marketValue: 10000 }],
        ]);
        const summary = summarizeDividends(payments, { asOf: AS_OF, year: 2025, valuations });

        expect(summary.year).toBe(2025);
        expect(summary.yearTotal).toBe(900); // 400 VTI + 500 ONEOFF in 2025
        expect(summary.ttmTotal).toBe(900);  // all 2025 payments within TTM
        // Portfolio value = VTI market value only (ONEOFF has no valuation).
        expect(summary.portfolioValue).toBe(10000);
        expect(summary.portfolioYield).toBeCloseTo(9, 6); // 900 / 10000
        // VTI projected, ONEOFF not.
        const vti = summary.perSecurity.find(s => s.ticker === 'VTI');
        expect(vti?.yieldOnCost).toBeCloseTo(8, 6); // 400 / 5000
        expect(summary.forwardCalendar.projections.find(p => p.ticker === 'ONEOFF')?.projected).toBe(false);
        expect(summary.projectedNext12mo).toBeGreaterThan(0);
    });
});
