/**
 * Business Reports — pure-logic tests.
 *
 * Exercises the database-free pieces of `business-reports.ts`:
 *   - aging bucketing (including exact 30/60/90 boundaries)
 *   - amount-due sign handling for AR vs AP lots
 *   - due-date computation from billterms
 *   - days-to-pay math
 *   - Schedule C keyword mapping (each line, meals at 50%, unmapped fallback)
 *   - sales-tax monthly grouping and sign normalization
 *   - empty-book behavior
 */

import { describe, it, expect } from 'vitest';
import {
    addDays,
    wholeDaysBetween,
    computeDueDate,
    bucketForDaysPastDue,
    amountDueFromLotBalance,
    buildAgingReport,
    sumDueWithin,
    computeDaysToPay,
    averageDaysToPay,
    mapExpenseAccountToLine,
    buildScheduleC,
    buildSalesTaxSummary,
    periodStarts,
    emptyBuckets,
    type RawOpenInvoiceRow,
    type ScheduleCAccountInput,
} from '../business-reports';

const ASOF = new Date('2026-07-08T00:00:00.000Z');

function inv(overrides: Partial<RawOpenInvoiceRow>): RawOpenInvoiceRow {
    return {
        guid: 'inv-1',
        id: '000001',
        ownerGuid: 'cust-1',
        ownerName: 'Acme Corp',
        datePosted: '2026-06-01T00:00:00.000Z',
        dueDays: 30,
        lotBalance: 100,
        currency: 'USD',
        ...overrides,
    };
}

/* ------------------------------------------------------------------ */
/* Bucketing                                                            */
/* ------------------------------------------------------------------ */

describe('bucketForDaysPastDue', () => {
    it('puts not-yet-due and due-today invoices in current', () => {
        expect(bucketForDaysPastDue(-10)).toBe('current');
        expect(bucketForDaysPastDue(0)).toBe('current');
    });

    it('handles the 1-30 bucket including the exact 30-day boundary', () => {
        expect(bucketForDaysPastDue(1)).toBe('b1_30');
        expect(bucketForDaysPastDue(30)).toBe('b1_30');
        expect(bucketForDaysPastDue(31)).toBe('b31_60');
    });

    it('handles the exact 60-day boundary', () => {
        expect(bucketForDaysPastDue(60)).toBe('b31_60');
        expect(bucketForDaysPastDue(61)).toBe('b61_90');
    });

    it('handles the exact 90-day boundary', () => {
        expect(bucketForDaysPastDue(90)).toBe('b61_90');
        expect(bucketForDaysPastDue(91)).toBe('b90plus');
        expect(bucketForDaysPastDue(365)).toBe('b90plus');
    });
});

/* ------------------------------------------------------------------ */
/* Sign handling                                                        */
/* ------------------------------------------------------------------ */

describe('amountDueFromLotBalance', () => {
    it('AR: unpaid customer invoice lots carry positive balances', () => {
        expect(amountDueFromLotBalance(250, 'ar')).toBe(250);
    });

    it('AP: unpaid vendor bill lots carry negative balances', () => {
        expect(amountDueFromLotBalance(-250, 'ap')).toBe(250);
    });

    it('credit notes read as negative amounts due on both sides', () => {
        expect(amountDueFromLotBalance(-50, 'ar')).toBe(-50); // AR credit note
        expect(amountDueFromLotBalance(50, 'ap')).toBe(-50); // AP credit note
    });
});

/* ------------------------------------------------------------------ */
/* Due dates                                                            */
/* ------------------------------------------------------------------ */

describe('computeDueDate', () => {
    const posted = new Date('2026-06-01T00:00:00.000Z');

    it('adds billterms duedays to the post date', () => {
        expect(computeDueDate(posted, 30).toISOString().slice(0, 10)).toBe('2026-07-01');
    });

    it('falls back to the post date when there are no terms', () => {
        expect(computeDueDate(posted, null).toISOString()).toBe(posted.toISOString());
        expect(computeDueDate(posted, undefined).toISOString()).toBe(posted.toISOString());
    });
});

/* ------------------------------------------------------------------ */
/* Aging report                                                         */
/* ------------------------------------------------------------------ */

describe('buildAgingReport', () => {
    it('returns an empty report for an empty book', () => {
        const report = buildAgingReport([], 'ar', ASOF);
        expect(report.owners).toEqual([]);
        expect(report.grandTotal).toBe(0);
        expect(report.invoiceCount).toBe(0);
        expect(report.totals).toEqual(emptyBuckets());
    });

    it('buckets an overdue AR invoice by days past its terms-derived due date', () => {
        // Posted 2026-06-01, net 15 → due 2026-06-16 → 22 days past due at ASOF.
        const report = buildAgingReport(
            [inv({ dueDays: 15, lotBalance: 500 })],
            'ar',
            ASOF,
        );
        expect(report.owners).toHaveLength(1);
        const owner = report.owners[0];
        expect(owner.invoices[0].daysPastDue).toBe(22);
        expect(owner.invoices[0].bucket).toBe('b1_30');
        expect(owner.buckets.b1_30).toBe(500);
        expect(report.totals.b1_30).toBe(500);
        expect(report.grandTotal).toBe(500);
    });

    it('treats no-terms invoices as due on the post date', () => {
        // Posted 2026-06-01, no terms → due 2026-06-01 → 37 days past due.
        const report = buildAgingReport([inv({ dueDays: null })], 'ar', ASOF);
        expect(report.owners[0].invoices[0].daysPastDue).toBe(37);
        expect(report.owners[0].invoices[0].bucket).toBe('b31_60');
    });

    it('groups multiple invoices per owner and totals across buckets', () => {
        const rows = [
            inv({ guid: 'i1', lotBalance: 100, dueDays: 60 }), // due 2026-07-31 → current
            inv({ guid: 'i2', lotBalance: 200, dueDays: 0 }), // due 2026-06-01 → 37d → 31-60
            inv({ guid: 'i3', ownerGuid: 'cust-2', ownerName: 'Beta LLC', lotBalance: 50, dueDays: 30 }),
        ];
        const report = buildAgingReport(rows, 'ar', ASOF);
        expect(report.owners).toHaveLength(2);
        const acme = report.owners.find((o) => o.ownerGuid === 'cust-1')!;
        expect(acme.total).toBe(300);
        expect(acme.buckets.current).toBe(100);
        expect(acme.buckets.b31_60).toBe(200);
        expect(report.grandTotal).toBe(350);
        // Owners sorted by total descending.
        expect(report.owners[0].ownerGuid).toBe('cust-1');
    });

    it('negates lot balances for the AP side', () => {
        const report = buildAgingReport(
            [inv({ ownerGuid: 'vend-1', ownerName: 'Supplies Inc', lotBalance: -750, dueDays: 0 })],
            'ap',
            ASOF,
        );
        expect(report.owners[0].total).toBe(750);
        expect(report.grandTotal).toBe(750);
    });
});

describe('sumDueWithin', () => {
    it('includes overdue and soon-due items, excludes far-future ones', () => {
        const rows = [
            inv({ guid: 'i1', lotBalance: -100, dueDays: 0 }), // due 2026-06-01 (overdue)
            inv({ guid: 'i2', lotBalance: -200, dueDays: 40 }), // due 2026-07-11 (in 3 days)
            inv({ guid: 'i3', lotBalance: -400, dueDays: 90 }), // due 2026-08-30 (far out)
        ];
        expect(sumDueWithin(rows, 'ap', 7, ASOF)).toBe(300);
        expect(sumDueWithin(rows, 'ap', 60, ASOF)).toBe(700);
    });

    it('returns 0 for an empty list', () => {
        expect(sumDueWithin([], 'ap', 30, ASOF)).toBe(0);
    });
});

/* ------------------------------------------------------------------ */
/* Days to pay                                                          */
/* ------------------------------------------------------------------ */

describe('days to pay', () => {
    it('computes whole days from post to payment', () => {
        expect(computeDaysToPay('2026-06-01T00:00:00Z', '2026-06-25T00:00:00Z')).toBe(24);
    });

    it('floors same-day payment to zero and never goes negative', () => {
        expect(computeDaysToPay('2026-06-01T00:00:00Z', '2026-06-01T12:00:00Z')).toBe(0);
        expect(computeDaysToPay('2026-06-10T00:00:00Z', '2026-06-01T00:00:00Z')).toBe(0);
    });

    it('averages to one decimal and returns null when empty', () => {
        expect(averageDaysToPay([10, 20, 25])).toBe(18.3);
        expect(averageDaysToPay([])).toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/* Schedule C mapping                                                   */
/* ------------------------------------------------------------------ */

describe('mapExpenseAccountToLine', () => {
    const cases: Array<[string, string, string]> = [
        ['Advertising', 'Expenses:Advertising', '8'],
        ['Marketing', 'Expenses:Marketing', '8'],
        ['Vehicle Fuel', 'Expenses:Vehicle Fuel', '9'],
        ['Insurance', 'Expenses:Insurance', '15'],
        ['Legal Fees', 'Expenses:Legal Fees', '17'],
        ['Accounting', 'Expenses:Accounting', '17'],
        ['Office Expense', 'Expenses:Office Expense', '18'],
        ['Rent', 'Expenses:Rent', '20'],
        ['Supplies', 'Expenses:Supplies', '22'],
        ['Licenses', 'Expenses:Licenses', '23'],
        ['Travel', 'Expenses:Travel', '24a'],
        ['Meals', 'Expenses:Meals', '24b'],
        ['Utilities', 'Expenses:Utilities', '25'],
        ['Internet', 'Expenses:Internet', '25'],
        ['Wages', 'Expenses:Wages', '26'],
        ['Salaries', 'Expenses:Salaries', '26'],
    ];

    it.each(cases)('maps %s to line %s', (name, path, expected) => {
        void path;
        expect(mapExpenseAccountToLine(name, `Expenses:${name}`)).toBe(expected);
    });

    it('sends payroll taxes to line 23, not wages', () => {
        expect(mapExpenseAccountToLine('Payroll Taxes', 'Expenses:Payroll Taxes')).toBe('23');
    });

    it('sends travel meals to meals (24b), not travel', () => {
        expect(mapExpenseAccountToLine('Travel Meals', 'Expenses:Travel Meals')).toBe('24b');
    });

    it('does not put taxi fares into taxes and licenses', () => {
        expect(mapExpenseAccountToLine('Taxi', 'Expenses:Taxi')).not.toBe('23');
    });

    it('inherits the line from the account path when the leaf name is generic', () => {
        expect(mapExpenseAccountToLine('Federal', 'Expenses:Taxes:Federal')).toBe('23');
    });

    it('returns null for unrecognized accounts', () => {
        expect(mapExpenseAccountToLine('Miscellaneous', 'Expenses:Miscellaneous')).toBeNull();
    });
});

describe('buildScheduleC', () => {
    const acct = (
        name: string,
        total: number,
        type: 'INCOME' | 'EXPENSE' = 'EXPENSE',
    ): ScheduleCAccountInput => ({
        guid: `g-${name}`,
        name,
        path: `${type === 'INCOME' ? 'Income' : 'Expenses'}:${name}`,
        type,
        total,
    });

    it('produces an all-zero report for an empty book', () => {
        const report = buildScheduleC(2025, []);
        expect(report.grossReceipts).toBe(0);
        expect(report.totalExpenses).toBe(0);
        expect(report.netProfit).toBe(0);
        expect(report.unmappedCount).toBe(0);
        expect(report.lines.every((l) => l.amount === 0)).toBe(true);
    });

    it('negates income for gross receipts (GnuCash stores income as credits)', () => {
        const report = buildScheduleC(2025, [acct('Consulting', -80000, 'INCOME')]);
        expect(report.grossReceipts).toBe(80000);
        expect(report.incomeAccounts[0].amount).toBe(80000);
    });

    it('deducts meals at 50% while reporting the full booked amount', () => {
        const report = buildScheduleC(2025, [
            acct('Consulting', -10000, 'INCOME'),
            acct('Meals', 1000),
        ]);
        const meals = report.lines.find((l) => l.line === '24b')!;
        expect(meals.amount).toBe(1000);
        expect(meals.deductible).toBe(500);
        expect(report.totalExpenses).toBe(500);
        expect(report.netProfit).toBe(9500);
    });

    it('routes unmapped expenses to line 27a with an itemized list', () => {
        const report = buildScheduleC(2025, [
            acct('Consulting', -5000, 'INCOME'),
            acct('Widgets and Gizmos', 300),
            acct('Mystery Costs', 200),
        ]);
        const other = report.lines.find((l) => l.line === '27a')!;
        expect(other.amount).toBe(500);
        expect(other.accounts).toHaveLength(2);
        expect(report.unmappedCount).toBe(2);
        expect(report.netProfit).toBe(4500);
    });

    it('maps a full small-business book onto the standard lines', () => {
        const report = buildScheduleC(2025, [
            acct('Sales', -100000, 'INCOME'),
            acct('Advertising', 2000),
            acct('Vehicle Fuel', 1500),
            acct('Insurance', 1200),
            acct('Legal Fees', 800),
            acct('Office Expense', 600),
            acct('Rent', 12000),
            acct('Supplies', 900),
            acct('Licenses', 300),
            acct('Travel', 2500),
            acct('Meals', 1000),
            acct('Utilities', 1800),
            acct('Wages', 30000),
        ]);
        const byLine = new Map(report.lines.map((l) => [l.line, l]));
        expect(byLine.get('8')!.amount).toBe(2000);
        expect(byLine.get('9')!.amount).toBe(1500);
        expect(byLine.get('15')!.amount).toBe(1200);
        expect(byLine.get('17')!.amount).toBe(800);
        expect(byLine.get('18')!.amount).toBe(600);
        expect(byLine.get('20')!.amount).toBe(12000);
        expect(byLine.get('22')!.amount).toBe(900);
        expect(byLine.get('23')!.amount).toBe(300);
        expect(byLine.get('24a')!.amount).toBe(2500);
        expect(byLine.get('24b')!.deductible).toBe(500);
        expect(byLine.get('25')!.amount).toBe(1800);
        expect(byLine.get('26')!.amount).toBe(30000);
        // 2000+1500+1200+800+600+12000+900+300+2500+500+1800+30000 = 54100
        expect(report.totalExpenses).toBe(54100);
        expect(report.netProfit).toBe(45900);
        expect(report.unmappedCount).toBe(0);
    });

    it('skips near-zero accounts', () => {
        const report = buildScheduleC(2025, [acct('Meals', 0.001)]);
        expect(report.lines.find((l) => l.line === '24b')!.accounts).toHaveLength(0);
    });
});

/* ------------------------------------------------------------------ */
/* Sales tax                                                            */
/* ------------------------------------------------------------------ */

describe('buildSalesTaxSummary', () => {
    it('returns empty structures for an empty book', () => {
        const summary = buildSalesTaxSummary([], []);
        expect(summary.accounts).toEqual([]);
        expect(summary.monthly).toEqual([]);
        expect(summary.totals).toEqual({ taxableSales: 0, taxCollected: 0 });
    });

    it('groups tax and sales by month with sign normalization', () => {
        const summary = buildSalesTaxSummary(
            [
                // Tax collected posts as credits (negative raw values).
                { month: '2026-01', accountGuid: 'tax-1', accountName: 'Sales Tax Payable', amount: -82.5 },
                { month: '2026-02', accountGuid: 'tax-1', accountName: 'Sales Tax Payable', amount: -41.25 },
            ],
            [
                { month: '2026-01', amount: -1000 },
                { month: '2026-02', amount: -500 },
            ],
        );
        expect(summary.monthly).toEqual([
            { month: '2026-01', taxableSales: 1000, taxCollected: 82.5 },
            { month: '2026-02', taxableSales: 500, taxCollected: 41.25 },
        ]);
        expect(summary.totals.taxableSales).toBe(1500);
        expect(summary.totals.taxCollected).toBe(123.75);
    });

    it('aggregates per target account and attaches rate info', () => {
        const rates = new Map([
            ['tax-1', [{ tableName: 'CA Sales Tax', rate: 8.25, rateType: 'percent' as const }]],
        ]);
        const summary = buildSalesTaxSummary(
            [
                { month: '2026-01', accountGuid: 'tax-1', accountName: 'Sales Tax Payable', amount: -50 },
                { month: '2026-02', accountGuid: 'tax-1', accountName: 'Sales Tax Payable', amount: -25 },
                { month: '2026-01', accountGuid: 'tax-2', accountName: 'County Tax', amount: -10 },
            ],
            [],
            rates,
        );
        expect(summary.accounts).toHaveLength(2);
        expect(summary.accounts[0].accountGuid).toBe('tax-1');
        expect(summary.accounts[0].taxCollected).toBe(75);
        expect(summary.accounts[0].tables[0].tableName).toBe('CA Sales Tax');
        expect(summary.accounts[1].taxCollected).toBe(10);
        expect(summary.accounts[1].tables).toEqual([]);
    });

    it('sorts months chronologically even when input is unordered', () => {
        const summary = buildSalesTaxSummary(
            [],
            [
                { month: '2026-03', amount: -300 },
                { month: '2026-01', amount: -100 },
            ],
        );
        expect(summary.monthly.map((m) => m.month)).toEqual(['2026-01', '2026-03']);
    });
});

/* ------------------------------------------------------------------ */
/* Period helpers                                                       */
/* ------------------------------------------------------------------ */

describe('periodStarts', () => {
    it('computes UTC month/quarter/year starts', () => {
        const { monthStart, quarterStart, yearStart } = periodStarts(new Date('2026-08-15T12:00:00Z'));
        expect(monthStart.toISOString()).toBe('2026-08-01T00:00:00.000Z');
        expect(quarterStart.toISOString()).toBe('2026-07-01T00:00:00.000Z');
        expect(yearStart.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });
});

describe('date helpers', () => {
    it('addDays and wholeDaysBetween round-trip', () => {
        const d = new Date('2026-06-01T00:00:00Z');
        expect(wholeDaysBetween(addDays(d, 45), d)).toBe(45);
    });
});
