/**
 * Net-Worth Attribution engine tests
 *
 * The core invariant under test:
 *   startNetWorth + savings + marketGains + debtPaydown + other === endNetWorth
 * exactly, for any mix of activity — plus component isolation cases and the
 * Year-in-Review pure card builders.
 */

import { describe, it, expect } from 'vitest';
import {
    computeNetWorthAttribution,
    classifyAccount,
    priceAsOf,
    buildMonthBuckets,
    type AttributionInput,
    type AttributionAccountInput,
    type AttributionSplitInput,
    type PricePoint,
} from '@/lib/reports/net-worth-attribution';
import {
    buildNetWorthCard,
    buildCashFlowCard,
    buildTopCategories,
    buildHoldingsCard,
    buildDividendCard,
    classifyYearSubscriptions,
    pickBusiestMerchant,
    buildBudgetStreak,
} from '@/lib/reports/year-in-review';
import type { RecurringSeries, SpendingTransaction } from '@/lib/recurring-detection';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const USD = 'cur-usd';
const VTI = 'cmdty-vti';

function acct(
    guid: string,
    accountType: string,
    overrides: Partial<AttributionAccountInput> = {}
): AttributionAccountInput {
    return {
        guid,
        name: overrides.name ?? guid,
        accountType,
        commodityGuid: overrides.commodityGuid ?? USD,
        commodityNamespace: overrides.commodityNamespace ?? 'CURRENCY',
    };
}

const ACCOUNTS: AttributionAccountInput[] = [
    acct('checking', 'BANK', { name: 'Assets:Checking' }),
    acct('stock-vti', 'STOCK', {
        name: 'Assets:Brokerage:VTI',
        commodityGuid: VTI,
        commodityNamespace: 'NASDAQ',
    }),
    acct('mortgage', 'LIABILITY', { name: 'Liabilities:Mortgage' }),
    acct('salary', 'INCOME', { name: 'Income:Salary' }),
    acct('groceries', 'EXPENSE', { name: 'Expenses:Groceries' }),
    acct('interest', 'EXPENSE', { name: 'Expenses:Mortgage Interest' }),
    acct('opening', 'EQUITY', { name: 'Equity:Opening Balances' }),
];

let txCounter = 0;

/** Build a balanced transaction's splits: [accountGuid, value, quantity?][] */
function tx(
    dateIso: string,
    entries: Array<[string, number, number?]>
): AttributionSplitInput[] {
    txCounter += 1;
    const txGuid = `tx-${txCounter}`;
    const postDate = new Date(`${dateIso}T12:00:00.000Z`);
    return entries.map(([accountGuid, value, quantity]) => ({
        txGuid,
        accountGuid,
        postDate,
        value,
        quantity: quantity ?? value,
    }));
}

const VTI_PRICES: PricePoint[] = [
    // Sorted date DESC as the engine requires
    { date: new Date('2025-03-20T00:00:00Z'), value: 120 },
    { date: new Date('2025-02-15T00:00:00Z'), value: 110 },
    { date: new Date('2024-12-15T00:00:00Z'), value: 100 },
];

function baseInput(overrides: Partial<AttributionInput> = {}): AttributionInput {
    return {
        accounts: ACCOUNTS,
        startingCashValues: new Map(),
        startingInvestmentQty: new Map(),
        periodSplits: [],
        prices: new Map([[VTI, VTI_PRICES]]),
        periodStart: new Date('2025-01-01T00:00:00.000Z'),
        periodEnd: new Date('2025-03-31T23:59:59.999Z'),
        ...overrides,
    };
}

function assertInvariant(result: ReturnType<typeof computeNetWorthAttribution>) {
    const { startNetWorth, endNetWorth, components } = result;
    const sum =
        components.savings + components.marketGains + components.debtPaydown + components.other;
    // Cents-exact: displayed figures must satisfy the invariant with no drift
    expect(Math.round((startNetWorth + sum - endNetWorth) * 100)).toBe(0);
    expect(result.totalChange).toBeCloseTo(sum, 6);
}

/* ------------------------------------------------------------------ */
/* Attribution engine                                                  */
/* ------------------------------------------------------------------ */

describe('computeNetWorthAttribution — sum-to-total invariant', () => {
    it('holds under mixed activity (income, spending, mortgage, buys, equity)', () => {
        const input = baseInput({
            startingCashValues: new Map([
                ['checking', 10000],
                ['mortgage', -200000],
            ]),
            startingInvestmentQty: new Map([['stock-vti', 10]]),
            periodSplits: [
                // Paycheck
                ...tx('2025-01-10', [['checking', 5000], ['salary', -5000]]),
                // Groceries
                ...tx('2025-01-15', [['checking', -800], ['groceries', 800]]),
                // Mortgage payment: 1500 principal + 500 interest
                ...tx('2025-02-01', [
                    ['checking', -2000],
                    ['mortgage', 1500],
                    ['interest', 500],
                ]),
                // Buy 10 VTI @ 110
                ...tx('2025-02-20', [
                    ['checking', -1100],
                    ['stock-vti', 1100, 10],
                ]),
                // Opening-balance style equity posting
                ...tx('2025-03-05', [['checking', 250], ['opening', -250]]),
            ],
        });

        const result = computeNetWorthAttribution(input);

        // Start: 10,000 − 200,000 + 10 sh × $100 = −189,000
        expect(result.startNetWorth).toBeCloseTo(-189000, 2);
        // End: 11,350 − 198,500 + 20 sh × $120 = −184,750
        expect(result.endNetWorth).toBeCloseTo(-184750, 2);
        expect(result.totalChange).toBeCloseTo(4250, 2);

        // Components
        expect(result.components.savings).toBeCloseTo(2200, 2); // 5000 − 800 − 500 interest − 1500 debt service
        expect(result.components.marketGains).toBeCloseTo(300, 2); // 100 (Feb on new lot) + 200 (Mar)
        expect(result.components.debtPaydown).toBeCloseTo(1500, 2);
        expect(result.components.other).toBeCloseTo(250, 2); // equity posting

        assertInvariant(result);
    });

    it('holds on an empty period (no activity at all)', () => {
        const result = computeNetWorthAttribution(
            baseInput({
                startingCashValues: new Map([['checking', 1234.56]]),
            })
        );
        expect(result.totalChange).toBe(0);
        expect(result.components).toEqual({
            savings: 0,
            marketGains: 0,
            debtPaydown: 0,
            other: 0,
        });
        assertInvariant(result);
    });

    it('pushes rounding residue into the other bucket, keeping cents exact', () => {
        // Amounts with sub-cent thirds force rounding on every component
        const third = 100 / 3;
        const input = baseInput({
            startingCashValues: new Map([['checking', 1000]]),
            periodSplits: [
                ...tx('2025-01-10', [['checking', third], ['salary', -third]]),
                ...tx('2025-02-10', [['checking', third], ['salary', -third]]),
                ...tx('2025-03-10', [['checking', third], ['salary', -third]]),
            ],
        });
        const result = computeNetWorthAttribution(input);
        assertInvariant(result);
    });
});

describe('computeNetWorthAttribution — market gain isolation', () => {
    it('isolates valuation change from flows for a mid-period buy at a rising price', () => {
        const input = baseInput({
            startingCashValues: new Map([['checking', 5000]]),
            prices: new Map([
                [
                    VTI,
                    [
                        { date: new Date('2025-03-25T00:00:00Z'), value: 130 },
                        { date: new Date('2025-02-10T00:00:00Z'), value: 120 },
                        { date: new Date('2025-01-05T00:00:00Z'), value: 100 },
                    ],
                ],
            ]),
            periodSplits: [
                // Buy 10 sh @ 120 on Feb 12 — the price already rose from 100,
                // but that pre-purchase rise must NOT count as our gain.
                ...tx('2025-02-12', [
                    ['checking', -1200],
                    ['stock-vti', 1200, 10],
                ]),
            ],
        });

        const result = computeNetWorthAttribution(input);

        // Gain = endValue(10×130) − startValue(0) − netInvested(1200) = 100
        expect(result.components.marketGains).toBeCloseTo(100, 2);
        expect(result.components.savings).toBe(0);
        expect(result.components.debtPaydown).toBe(0);
        expect(result.components.other).toBe(0);
        expect(result.totalChange).toBeCloseTo(100, 2);

        const row = result.drilldown.market[0];
        expect(row.startValue).toBe(0);
        expect(row.netInvested).toBeCloseTo(1200, 2);
        expect(row.endValue).toBeCloseTo(1300, 2);
        expect(row.gain).toBeCloseTo(100, 2);

        assertInvariant(result);
    });
});

describe('computeNetWorthAttribution — debt paydown vs interest', () => {
    it('reports principal as debt paydown and interest as spending', () => {
        const input = baseInput({
            startingCashValues: new Map([
                ['checking', 10000],
                ['mortgage', -100000],
            ]),
            periodSplits: [
                ...tx('2025-01-15', [
                    ['checking', -2000],
                    ['mortgage', 1500],
                    ['interest', 500],
                ]),
            ],
        });

        const result = computeNetWorthAttribution(input);

        // Principal only — never the interest
        expect(result.components.debtPaydown).toBeCloseTo(1500, 2);
        // Savings nets the interest (spending) and the principal transfer (debt service)
        expect(result.components.savings).toBeCloseTo(-2000, 2);
        // Net-worth truth: only the interest left the household
        expect(result.totalChange).toBeCloseTo(-500, 2);

        // Drill-down splits the story
        const interestRow = result.drilldown.savings.find(r => r.guid === 'interest');
        expect(interestRow?.amount).toBeCloseTo(-500, 2);
        expect(interestRow?.kind).toBe('expense');

        const debtService = result.drilldown.savings.find(r => r.kind === 'debt_service');
        expect(debtService?.amount).toBeCloseTo(-1500, 2);

        const mortgageRow = result.drilldown.debt.find(r => r.accountGuid === 'mortgage');
        expect(mortgageRow?.startBalance).toBeCloseTo(-100000, 2);
        expect(mortgageRow?.endBalance).toBeCloseTo(-98500, 2);
        expect(mortgageRow?.change).toBeCloseTo(1500, 2);

        assertInvariant(result);
    });

    it('treats new borrowing as negative debt paydown', () => {
        const input = baseInput({
            startingCashValues: new Map([['checking', 1000]]),
            periodSplits: [
                // Take out a 5,000 loan
                ...tx('2025-02-01', [['checking', 5000], ['mortgage', -5000]]),
            ],
        });
        const result = computeNetWorthAttribution(input);
        expect(result.components.debtPaydown).toBeCloseTo(-5000, 2);
        expect(result.components.savings).toBeCloseTo(5000, 2); // cash received (debt service, negative direction)
        expect(result.totalChange).toBe(0); // borrowing is net-worth neutral
        assertInvariant(result);
    });
});

describe('computeNetWorthAttribution — residual bucket', () => {
    it('captures equity postings and unbalanced splits honestly', () => {
        const input = baseInput({
            startingCashValues: new Map([['checking', 0]]),
            periodSplits: [
                // Opening balance from equity
                ...tx('2025-01-02', [['checking', 1000], ['opening', -1000]]),
                // A split whose counterpart lives outside the fetched book
                ...tx('2025-02-02', [['checking', 300]]),
            ],
        });

        const result = computeNetWorthAttribution(input);

        expect(result.components.other).toBeCloseTo(1300, 2);
        expect(result.components.savings).toBe(0);

        const equityRow = result.drilldown.other.find(r => r.guid === 'opening');
        expect(equityRow?.amount).toBeCloseTo(1000, 2);

        const unbalancedRow = result.drilldown.other.find(r => r.guid === null);
        expect(unbalancedRow?.amount).toBeCloseTo(300, 2);

        assertInvariant(result);
    });

    it('is empty when every flow is explained', () => {
        const input = baseInput({
            startingCashValues: new Map([['checking', 500]]),
            periodSplits: [...tx('2025-01-20', [['checking', 100], ['salary', -100]])],
        });
        const result = computeNetWorthAttribution(input);
        expect(result.components.other).toBe(0);
        expect(result.drilldown.other).toEqual([]);
        assertInvariant(result);
    });
});

describe('computeNetWorthAttribution — monthly series', () => {
    it('buckets the decomposition by month and sums back to the period totals', () => {
        const input = baseInput({
            startingCashValues: new Map([
                ['checking', 10000],
                ['mortgage', -200000],
            ]),
            startingInvestmentQty: new Map([['stock-vti', 10]]),
            periodSplits: [
                ...tx('2025-01-10', [['checking', 5000], ['salary', -5000]]),
                ...tx('2025-01-15', [['checking', -800], ['groceries', 800]]),
                ...tx('2025-02-01', [
                    ['checking', -2000],
                    ['mortgage', 1500],
                    ['interest', 500],
                ]),
                ...tx('2025-02-20', [['checking', -1100], ['stock-vti', 1100, 10]]),
                ...tx('2025-03-05', [['checking', 250], ['opening', -250]]),
            ],
        });

        const result = computeNetWorthAttribution(input);

        expect(result.monthly.map(m => m.month)).toEqual(['2025-01', '2025-02', '2025-03']);

        const [jan, feb, mar] = result.monthly;
        expect(jan.savings).toBeCloseTo(4200, 2);
        expect(jan.marketGains).toBeCloseTo(0, 2); // price still 100 at Jan 31
        expect(feb.savings).toBeCloseTo(-2000, 2);
        expect(feb.debtPaydown).toBeCloseTo(1500, 2);
        expect(feb.marketGains).toBeCloseTo(100, 2); // 20 sh × 110 − 1000 − 1100
        expect(mar.marketGains).toBeCloseTo(200, 2); // 20 sh × (120 − 110)
        expect(mar.other).toBeCloseTo(250, 2);

        // Each month's netChange is the sum of its components
        for (const m of result.monthly) {
            expect(m.netChange).toBeCloseTo(
                m.savings + m.marketGains + m.debtPaydown + m.other,
                2
            );
        }

        // Monthly series telescopes back to the period totals (within rounding)
        const sums = result.monthly.reduce(
            (acc, m) => ({
                savings: acc.savings + m.savings,
                market: acc.market + m.marketGains,
                debt: acc.debt + m.debtPaydown,
                other: acc.other + m.other,
            }),
            { savings: 0, market: 0, debt: 0, other: 0 }
        );
        expect(sums.savings).toBeCloseTo(result.components.savings, 1);
        expect(sums.market).toBeCloseTo(result.components.marketGains, 1);
        expect(sums.debt).toBeCloseTo(result.components.debtPaydown, 1);
        expect(sums.other).toBeCloseTo(result.components.other, 1);
    });

    it('spans partial months from the period boundaries', () => {
        const buckets = buildMonthBuckets(
            new Date('2025-01-15T00:00:00Z'),
            new Date('2025-03-10T23:59:59Z')
        );
        expect(buckets.map(b => b.month)).toEqual(['2025-01', '2025-02', '2025-03']);
        expect(buckets[2].end.toISOString().slice(0, 10)).toBe('2025-03-10');
    });
});

describe('attribution helpers', () => {
    it('classifies accounts into groups', () => {
        expect(classifyAccount(acct('a', 'BANK'))).toBe('cash');
        expect(classifyAccount(acct('a', 'RECEIVABLE'))).toBe('cash');
        expect(
            classifyAccount(acct('a', 'STOCK', { commodityGuid: VTI, commodityNamespace: 'NASDAQ' }))
        ).toBe('investment');
        // A STOCK account denominated in a currency behaves like cash
        expect(classifyAccount(acct('a', 'STOCK'))).toBe('cash');
        expect(classifyAccount(acct('a', 'CREDIT'))).toBe('liability');
        expect(classifyAccount(acct('a', 'INCOME'))).toBe('income');
        expect(classifyAccount(acct('a', 'EXPENSE'))).toBe('expense');
        expect(classifyAccount(acct('a', 'EQUITY'))).toBe('other');
        expect(classifyAccount(acct('a', 'TRADING'))).toBe('other');
    });

    it('priceAsOf uses latest ≤ date and falls back to the earliest known price', () => {
        expect(priceAsOf(VTI_PRICES, new Date('2025-02-20T00:00:00Z'))).toBe(110);
        expect(priceAsOf(VTI_PRICES, new Date('2026-01-01T00:00:00Z'))).toBe(120);
        // Before all history: earliest price, not 0
        expect(priceAsOf(VTI_PRICES, new Date('2024-01-01T00:00:00Z'))).toBe(100);
        expect(priceAsOf([], new Date())).toBe(0);
        expect(priceAsOf(undefined, new Date())).toBe(0);
    });
});

/* ------------------------------------------------------------------ */
/* Year in Review card builders                                        */
/* ------------------------------------------------------------------ */

describe('year-in-review card builders', () => {
    it('buildNetWorthCard maps attribution output and skips a flat book', () => {
        const card = buildNetWorthCard({
            startNetWorth: 100000,
            endNetWorth: 112000,
            totalChange: 12000,
            components: { savings: 8000, marketGains: 3000, debtPaydown: 1500, other: -500 },
        });
        expect(card).toEqual({
            start: 100000,
            end: 112000,
            change: 12000,
            changePercent: 12,
            savings: 8000,
            marketGains: 3000,
            debtPaydown: 1500,
            other: -500,
        });

        expect(
            buildNetWorthCard({
                startNetWorth: 0,
                endNetWorth: 0,
                totalChange: 0,
                components: { savings: 0, marketGains: 0, debtPaydown: 0, other: 0 },
            })
        ).toBeNull();
    });

    it('buildCashFlowCard computes savings rate and skips empty years', () => {
        const card = buildCashFlowCard(100000, 60000);
        expect(card).toEqual({ income: 100000, expenses: 60000, net: 40000, savingsRate: 40 });
        expect(buildCashFlowCard(0, 0)).toBeNull();
    });

    it('buildTopCategories ranks with YoY deltas and skips empty spending', () => {
        const rows = buildTopCategories(
            { Housing: 24000, Food: 9000, Travel: 4000, Hobby: 100 },
            { Housing: 22000, Food: 10000, Travel: 0 },
            3
        );
        expect(rows).not.toBeNull();
        expect(rows!.map(r => r.name)).toEqual(['Housing', 'Food', 'Travel']);
        expect(rows![0]).toMatchObject({ amount: 24000, priorAmount: 22000, delta: 2000 });
        expect(rows![0].percent).toBeCloseTo(9.09, 2);
        expect(rows![2]).toMatchObject({ delta: 4000, percent: 0 }); // no prior base

        expect(buildTopCategories({}, { Food: 100 })).toBeNull();
    });

    it('buildHoldingsCard picks best and worst by simple return', () => {
        const card = buildHoldingsCard([
            { accountGuid: 'a', name: 'VTI', startValue: 10000, endValue: 12000, netInvested: 0, gain: 2000 },
            { accountGuid: 'b', name: 'ARKK', startValue: 5000, endValue: 3000, netInvested: 500, gain: -2500 },
            { accountGuid: 'c', name: 'Dust', startValue: 0.5, endValue: 0.6, netInvested: 0, gain: 0.1 },
        ]);
        expect(card).not.toBeNull();
        expect(card!.best.name).toBe('VTI');
        expect(card!.best.returnPct).toBeCloseTo(20, 2);
        expect(card!.worst?.name).toBe('ARKK');
        expect(card!.worst?.returnPct).toBeCloseTo(-45.45, 1);

        // Single eligible holding: no worst
        const single = buildHoldingsCard([
            { accountGuid: 'a', name: 'VTI', startValue: 10000, endValue: 11000, netInvested: 0, gain: 1000 },
        ]);
        expect(single!.worst).toBeNull();

        expect(buildHoldingsCard([])).toBeNull();
    });

    it('buildDividendCard trims payers and skips dividend-free years', () => {
        const card = buildDividendCard(1200, 1000, 14, [
            { ticker: 'VTI', amount: 700 },
            { ticker: 'SCHD', amount: 500 },
            { ticker: 'ZERO', amount: 0 },
        ]);
        expect(card).toMatchObject({ total: 1200, priorTotal: 1000, delta: 200, paymentCount: 14 });
        expect(card!.topPayers).toHaveLength(2);

        expect(buildDividendCard(0, 0, 0, [])).toBeNull();
    });

    it('classifyYearSubscriptions splits added vs dropped for the year', () => {
        const series = (overrides: Partial<RecurringSeries>): RecurringSeries => ({
            merchantKey: 'x',
            merchantLabel: 'X',
            cadence: 'monthly',
            medianIntervalDays: 30,
            occurrences: 6,
            currentAmount: 10,
            typicalAmount: 10,
            amountChangePct: 0,
            firstSeen: '2024-01-05',
            lastSeen: '2025-06-05',
            nextExpected: '2025-07-05',
            status: 'active',
            monthlyEquivalent: 10,
            accountGuid: 'exp',
            accountName: 'Expenses:Subscriptions',
            ...overrides,
        });

        const card = classifyYearSubscriptions(
            [
                series({ merchantLabel: 'NewFlix', firstSeen: '2025-03-01', status: 'new' }),
                series({
                    merchantLabel: 'OldBox',
                    firstSeen: '2023-01-01',
                    lastSeen: '2025-04-10',
                    nextExpected: '2025-05-10',
                    status: 'stopped',
                }),
                series({ merchantLabel: 'Steady', firstSeen: '2023-06-01' }),
                // Stopped long before the year — not dropped in 2025
                series({
                    merchantLabel: 'Ancient',
                    firstSeen: '2022-01-01',
                    lastSeen: '2023-02-01',
                    nextExpected: '2023-03-01',
                    status: 'stopped',
                }),
            ],
            2025
        );

        expect(card).not.toBeNull();
        expect(card!.added.map(s => s.label)).toEqual(['NewFlix']);
        expect(card!.dropped.map(s => s.label)).toEqual(['OldBox']);
        expect(card!.dropped[0].date).toBe('2025-04-10');

        expect(classifyYearSubscriptions([series({})], 2020)).toBeNull();
    });

    it('pickBusiestMerchant groups by normalized description within the year', () => {
        const spend = (date: string, description: string, amount: number): SpendingTransaction => ({
            date: new Date(`${date}T12:00:00Z`),
            description,
            amount,
            accountGuid: 'exp',
            accountName: 'Expenses:Food',
        });

        const card = pickBusiestMerchant(
            [
                spend('2025-01-03', 'COSTCO #1041', 120),
                spend('2025-02-10', 'Costco #2210', 80),
                spend('2025-05-21', 'costco', 100),
                spend('2025-03-01', 'Trader Joes', 40),
                spend('2025-03-08', 'Trader Joes', 45),
                // Outside the year — ignored
                spend('2024-12-30', 'COSTCO #1041', 500),
            ],
            2025
        );

        expect(card).not.toBeNull();
        expect(card!.visits).toBe(3);
        expect(card!.total).toBe(300);
        expect(card!.averageAmount).toBe(100);
        expect(card!.merchant.toLowerCase()).toContain('costco');

        // Below the minimum-visits bar
        expect(
            pickBusiestMerchant([spend('2025-01-03', 'One Off Shop', 10)], 2025)
        ).toBeNull();
    });

    it('buildBudgetStreak counts months under budget and the longest run', () => {
        const card = buildBudgetStreak('Household', [
            { month: '2025-01', budgeted: 1000, actual: 900 },
            { month: '2025-02', budgeted: 1000, actual: 999.99 },
            { month: '2025-03', budgeted: 1000, actual: 1200 },
            { month: '2025-04', budgeted: 1000, actual: 700 },
            { month: '2025-05', budgeted: 1000, actual: 800 },
            { month: '2025-06', budgeted: 1000, actual: 950 },
        ]);
        expect(card).not.toBeNull();
        expect(card!.monthsEvaluated).toBe(6);
        expect(card!.monthsUnderBudget).toBe(5);
        expect(card!.longestStreak).toBe(3);
        expect(card!.monthly[2].under).toBe(false);

        expect(buildBudgetStreak('Empty', [])).toBeNull();
        // Months without a budgeted amount are not evaluated
        expect(buildBudgetStreak('Zeroes', [{ month: '2025-01', budgeted: 0, actual: 50 }])).toBeNull();
    });
});
