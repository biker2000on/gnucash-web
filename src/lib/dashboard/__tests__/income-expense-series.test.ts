/**
 * ASI-6-007(a) — the dashboard income/expense series moved from "fetch every
 * split, reduce in JS" to a SQL GROUP BY plus this pure assembly step.
 *
 * The interesting risk in that move is not the SQL (a GROUP BY sum is a GROUP
 * BY sum) but whether the *classification* — income sign flip, tax subset,
 * per-account FX, zero-filled months — survived being lifted out of the split
 * loop. So the test keeps a faithful copy of the OLD per-split reducer, runs
 * both over the same fixture, and asserts they agree.
 */
import { describe, expect, it } from 'vitest';

import { buildMonthlySeries, type MonthlySeriesOptions } from '../income-expense-series';
import type { MonthlyAccountSum } from '@/lib/reports/utils';

const BASE = 'usd-commodity';
const EUR = 'eur-commodity';

const SALARY = 'acct-salary';
const DIVIDENDS = 'acct-dividends';
const GROCERIES = 'acct-groceries';
const FED_TAX = 'acct-federal-tax';
const EUR_CONSULTING = 'acct-eur-consulting';
const ASSET = 'acct-checking';

interface SplitFixture {
    accountGuid: string;
    /** GnuCash fraction, as the splits table stores it. */
    num: bigint;
    denom: bigint;
    postDate: Date;
}

/** Fixture: two quarters of activity, mixed signs, one foreign-currency account. */
const SPLITS: SplitFixture[] = [
    { accountGuid: SALARY, num: -500000n, denom: 100n, postDate: new Date(Date.UTC(2026, 0, 15)) },
    { accountGuid: SALARY, num: -500000n, denom: 100n, postDate: new Date(Date.UTC(2026, 0, 31)) },
    { accountGuid: DIVIDENDS, num: -12345n, denom: 100n, postDate: new Date(Date.UTC(2026, 0, 20)) },
    { accountGuid: GROCERIES, num: 8899n, denom: 100n, postDate: new Date(Date.UTC(2026, 0, 5)) },
    { accountGuid: GROCERIES, num: 12301n, denom: 100n, postDate: new Date(Date.UTC(2026, 0, 6)) },
    // Refund: a negative expense must net against its siblings, not be dropped.
    { accountGuid: GROCERIES, num: -2500n, denom: 100n, postDate: new Date(Date.UTC(2026, 0, 9)) },
    { accountGuid: FED_TAX, num: 150000n, denom: 100n, postDate: new Date(Date.UTC(2026, 0, 31)) },
    // February: income only, so expenses/taxes stay zero for that month.
    { accountGuid: SALARY, num: -500000n, denom: 100n, postDate: new Date(Date.UTC(2026, 1, 15)) },
    { accountGuid: EUR_CONSULTING, num: -100000n, denom: 100n, postDate: new Date(Date.UTC(2026, 1, 28)) },
    // March has nothing at all — it must still appear, zero-filled.
    // April: thirds, to exercise a non-power-of-ten denominator.
    { accountGuid: GROCERIES, num: 1000n, denom: 3n, postDate: new Date(Date.UTC(2026, 3, 2)) },
    { accountGuid: FED_TAX, num: 2000n, denom: 3n, postDate: new Date(Date.UTC(2026, 3, 3)) },
    // An account outside both sets: never counted, by either implementation.
    { accountGuid: ASSET, num: 999999n, denom: 100n, postDate: new Date(Date.UTC(2026, 0, 15)) },
];

const OPTIONS: Omit<MonthlySeriesOptions, 'ratesByAccount'> = {
    incomeGuids: new Set([SALARY, DIVIDENDS, EUR_CONSULTING]),
    expenseGuids: new Set([GROCERIES, FED_TAX]),
    taxExpenseGuids: new Set([FED_TAX]),
    startDate: new Date(Date.UTC(2026, 0, 1)),
    endDate: new Date(Date.UTC(2026, 3, 30, 23, 59, 59)),
};

const ACCOUNT_CURRENCY = new Map<string, string>([
    [SALARY, BASE],
    [DIVIDENDS, BASE],
    [GROCERIES, BASE],
    [FED_TAX, BASE],
    [EUR_CONSULTING, EUR],
    [ASSET, BASE],
]);
const EXCHANGE_RATES = new Map<string, number>([[EUR, 1.08]]);

const RATES_BY_ACCOUNT = new Map<string, number>(
    [...ACCOUNT_CURRENCY]
        .filter(([, currency]) => currency !== BASE)
        .map(([accountGuid, currency]) => [accountGuid, EXCHANGE_RATES.get(currency) || 1]),
);

/**
 * The pre-change route body, verbatim in behaviour: one pass over raw splits,
 * fraction division and FX per split, then zero-filled month generation.
 */
function legacyMonthlySeries(splits: SplitFixture[]) {
    const monthlyData = new Map<string, { income: number; expenses: number; taxes: number }>();

    for (const split of splits) {
        const postDate = split.postDate;
        const monthKey = `${postDate.getUTCFullYear()}-${String(postDate.getUTCMonth() + 1).padStart(2, '0')}`;
        const entry = monthlyData.get(monthKey) || { income: 0, expenses: 0, taxes: 0 };

        const rawValue = Number(split.num) / Number(split.denom);
        const accountCurrGuid = ACCOUNT_CURRENCY.get(split.accountGuid);
        const rate = (accountCurrGuid && accountCurrGuid !== BASE)
            ? (EXCHANGE_RATES.get(accountCurrGuid) || 1) : 1;
        const value = rawValue * rate;

        if (OPTIONS.incomeGuids.has(split.accountGuid)) {
            entry.income += -value;
        } else if (OPTIONS.expenseGuids.has(split.accountGuid)) {
            entry.expenses += value;
            if (OPTIONS.taxExpenseGuids.has(split.accountGuid)) {
                entry.taxes += value;
            }
        }

        monthlyData.set(monthKey, entry);
    }

    const monthly: Array<{ month: string; income: number; expenses: number; taxes: number; netProfit: number }> = [];
    const current = new Date(Date.UTC(
        OPTIONS.startDate.getUTCFullYear(), OPTIONS.startDate.getUTCMonth(), 1));
    const endMonth = new Date(Date.UTC(
        OPTIONS.endDate.getUTCFullYear(), OPTIONS.endDate.getUTCMonth(), 1));

    while (current <= endMonth) {
        const monthKey = `${current.getUTCFullYear()}-${String(current.getUTCMonth() + 1).padStart(2, '0')}`;
        const data = monthlyData.get(monthKey) || { income: 0, expenses: 0, taxes: 0 };
        monthly.push({
            month: monthKey,
            income: Math.round(data.income * 100) / 100,
            expenses: Math.round(data.expenses * 100) / 100,
            taxes: Math.round(data.taxes * 100) / 100,
            netProfit: Math.round((data.income - data.expenses) * 100) / 100,
        });
        current.setUTCMonth(current.getUTCMonth() + 1);
    }

    return monthly;
}

/** What the new `GROUP BY to_char(post_date,'YYYY-MM'), account_guid` returns. */
function groupLikeSql(splits: SplitFixture[], accountGuids: Set<string>): MonthlyAccountSum[] {
    const buckets = new Map<string, MonthlyAccountSum>();
    for (const split of splits) {
        if (!accountGuids.has(split.accountGuid)) continue;
        const month = `${split.postDate.getUTCFullYear()}-${String(split.postDate.getUTCMonth() + 1).padStart(2, '0')}`;
        const key = `${month}|${split.accountGuid}`;
        const bucket = buckets.get(key) || { month, accountGuid: split.accountGuid, quantity: 0 };
        bucket.quantity += Number(split.num) / Number(split.denom);
        buckets.set(key, bucket);
    }
    return [...buckets.values()];
}

const REQUESTED_GUIDS = new Set([...OPTIONS.incomeGuids, ...OPTIONS.expenseGuids]);

describe('buildMonthlySeries', () => {
    it('reproduces the old per-split reduction exactly', () => {
        const fresh = buildMonthlySeries(groupLikeSql(SPLITS, REQUESTED_GUIDS), {
            ...OPTIONS,
            ratesByAccount: RATES_BY_ACCOUNT,
        });

        expect(fresh).toEqual(legacyMonthlySeries(SPLITS));
    });

    it('produces the values the fixture spells out', () => {
        const series = buildMonthlySeries(groupLikeSql(SPLITS, REQUESTED_GUIDS), {
            ...OPTIONS,
            ratesByAccount: RATES_BY_ACCOUNT,
        });

        expect(series.map(m => m.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);

        // January: 5000 + 5000 salary + 123.45 dividends.
        expect(series[0].income).toBe(10123.45);
        // 88.99 + 123.01 - 25 groceries + 1500 tax.
        expect(series[0].expenses).toBe(1687);
        expect(series[0].taxes).toBe(1500);
        expect(series[0].netProfit).toBe(8436.45);

        // February: 5000 salary + 1000 EUR consulting at 1.08.
        expect(series[1].income).toBe(6080);
        expect(series[1].expenses).toBe(0);

        // March is empty but present.
        expect(series[2]).toEqual({
            month: '2026-03', income: 0, expenses: 0, taxes: 0, netProfit: 0,
        });

        // April: 1000/3 groceries + 2000/3 tax = 1000 exactly.
        expect(series[3].expenses).toBe(1000);
        expect(series[3].taxes).toBe(666.67);
    });

    it('ignores accounts outside the income/expense sets', () => {
        const withAsset = groupLikeSql(SPLITS, new Set([...REQUESTED_GUIDS, ASSET]));
        expect(withAsset.some(r => r.accountGuid === ASSET)).toBe(true);

        expect(buildMonthlySeries(withAsset, { ...OPTIONS, ratesByAccount: RATES_BY_ACCOUNT }))
            .toEqual(buildMonthlySeries(groupLikeSql(SPLITS, REQUESTED_GUIDS), {
                ...OPTIONS,
                ratesByAccount: RATES_BY_ACCOUNT,
            }));
    });

    it('treats a missing rate as 1, like the old per-split fallback', () => {
        const noRates = buildMonthlySeries(groupLikeSql(SPLITS, REQUESTED_GUIDS), {
            ...OPTIONS,
            ratesByAccount: new Map(),
        });
        // The EUR leg is now taken at face value: 6080 -> 6000.
        expect(noRates[1].income).toBe(6000);
    });

    it('zero-fills a window with no rows at all', () => {
        expect(buildMonthlySeries([], {
            ...OPTIONS,
            startDate: new Date(Date.UTC(2026, 5, 10)),
            endDate: new Date(Date.UTC(2026, 6, 20)),
            ratesByAccount: RATES_BY_ACCOUNT,
        })).toEqual([
            { month: '2026-06', income: 0, expenses: 0, taxes: 0, netProfit: 0 },
            { month: '2026-07', income: 0, expenses: 0, taxes: 0, netProfit: 0 },
        ]);
    });
});
