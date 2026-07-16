import { describe, it, expect } from 'vitest';
import {
    buildDemoSeedPlan,
    DEMO_BOOK_DESCRIPTION,
    DEMO_DESCRIPTION_PREFIX,
    type DemoSeedPlan,
    type DemoBookKind,
} from '../demo-seed';

const FIXED_TODAY = new Date('2026-07-15T17:23:00Z');
const KINDS: DemoBookKind[] = ['household', 'business'];

function splitSum(plan: DemoSeedPlan): void {
    for (const tx of plan.transactions) {
        const sum = tx.splits.reduce((acc, s) => acc + s.valueCents, 0);
        expect(sum, `transaction "${tx.description}" on ${tx.date} must balance`).toBe(0);
    }
}

describe('buildDemoSeedPlan', () => {
    it('marks demo books with the badge-detectable description', () => {
        expect(DEMO_BOOK_DESCRIPTION.startsWith(DEMO_DESCRIPTION_PREFIX)).toBe(true);
    });

    describe.each(KINDS)('%s plan', (kind) => {
        const plan = buildDemoSeedPlan(kind, FIXED_TODAY);

        it('is deterministic — two builds with the same date are identical', () => {
            const again = buildDemoSeedPlan(kind, FIXED_TODAY);
            expect(again).toEqual(plan);
            // and stringify-equal (catches undefined-vs-missing drift)
            expect(JSON.stringify(again)).toBe(JSON.stringify(plan));
        });

        it('every transaction balances to zero', () => {
            splitSum(plan);
        });

        it('every split references a declared account', () => {
            const declared = new Set(plan.accounts.map(a => a.path));
            for (const tx of plan.transactions) {
                for (const split of tx.splits) {
                    expect(declared.has(split.accountPath), `undeclared account ${split.accountPath}`).toBe(true);
                }
            }
        });

        it('all dates fall within the trailing year and never in the future', () => {
            const anchor = '2026-07-15';
            const yearAgo = '2025-07-14';
            for (const tx of plan.transactions) {
                expect(tx.date <= anchor, `future-dated txn ${tx.description} ${tx.date}`).toBe(true);
                expect(tx.date >= yearAgo, `too-old txn ${tx.description} ${tx.date}`).toBe(true);
            }
            for (const price of plan.prices) {
                expect(price.date <= anchor).toBe(true);
            }
        });

        it('transactions are sorted by date', () => {
            const dates = plan.transactions.map(t => t.date);
            expect(dates).toEqual([...dates].sort());
        });

        it('every split has at least two splits and a non-empty description', () => {
            for (const tx of plan.transactions) {
                expect(tx.splits.length).toBeGreaterThanOrEqual(2);
                expect(tx.description.length).toBeGreaterThan(0);
            }
        });
    });

    describe('household specifics (fixed at 2026-07-15)', () => {
        const plan = buildDemoSeedPlan('household', FIXED_TODAY);

        it('has stable transaction counts', () => {
            const byKind = (needle: string) =>
                plan.transactions.filter(t => t.description.includes(needle)).length;

            expect(byKind('Paycheck')).toBe(26);            // biweekly for a year
            expect(byKind('Rent')).toBe(12);                // monthly on the 1st
            expect(byKind('Netflix')).toBe(12);
            expect(byKind('Spotify')).toBe(12);
            expect(byKind('Electric & gas')).toBe(12);
            expect(byKind('Buy DMOFX')).toBe(11);           // the 20th of the current month hasn't arrived
            expect(byKind('Transfer to savings')).toBe(12);
            // 365-day window anchored on a Wednesday: 53 Wednesdays + 52 Saturdays
            expect(byKind('Groceries')).toBe(105);
            expect(byKind('Dinner out')).toBe(52);          // every Friday
            expect(byKind('Opening balance')).toBe(1);
            expect(plan.transactions.length).toBe(255);
        });

        it('has one price per investment buy, strictly increasing', () => {
            const buys = plan.transactions.filter(t => t.description.includes('Buy DMOFX'));
            expect(plan.prices.length).toBe(buys.length);
            for (let i = 1; i < plan.prices.length; i++) {
                expect(plan.prices[i].priceCents).toBeGreaterThan(plan.prices[i - 1].priceCents);
            }
        });

        it('paychecks split gross into withholdings, 401(k), and net pay', () => {
            const paycheck = plan.transactions.find(t => t.description.includes('Paycheck'))!;
            const salary = paycheck.splits.find(s => s.accountPath === 'Income:Salary')!;
            const net = paycheck.splits.find(s => s.accountPath.includes('Checking'))!;
            const k401 = paycheck.splits.find(s => s.accountPath.includes('401(k)'))!;
            expect(salary.valueCents).toBeLessThan(0);       // income credit
            expect(net.valueCents).toBeGreaterThan(0);
            expect(k401.valueCents).toBeGreaterThan(0);
            expect(paycheck.splits.length).toBe(7);
        });

        it('stock buys carry share quantities distinct from cash value', () => {
            const buy = plan.transactions.find(t => t.description.includes('Buy DMOFX'))!;
            const stockSplit = buy.splits.find(s => s.accountPath.includes('Demo Index Fund'))!;
            expect(stockSplit.quantityDenom).toBe(10000);
            expect(stockSplit.quantityNum).toBeGreaterThan(0);
            expect(stockSplit.quantityNum).not.toBe(stockSplit.valueCents);
        });

        it('has no tax mappings (household books are mapped by the user)', () => {
            expect(plan.taxMappings).toEqual([]);
        });
    });

    describe('business specifics (fixed at 2026-07-15)', () => {
        const plan = buildDemoSeedPlan('business', FIXED_TODAY);

        it('has stable transaction counts', () => {
            const invoices = plan.transactions.filter(t => t.description.startsWith('Invoice'));
            const payments = plan.transactions.filter(t => t.description.startsWith('Payment'));

            expect(invoices.length).toBe(36);   // 3 customers x 12 months
            // Unpaid: last invoice of customers 0+1, plus every payment that
            // would land after the anchor (July invoices pay on the 23rd).
            expect(payments.length).toBe(33);
            expect(plan.transactions.filter(t => t.description.includes('SaaS')).length).toBe(12);
            expect(plan.transactions.filter(t => t.description.includes('insurance')).length).toBe(12);
            expect(plan.transactions.filter(t => t.description === 'Owner draw').length).toBe(4);
            expect(plan.transactions.length).toBe(98);
        });

        it('leaves a few invoices unpaid so AR stays open', () => {
            const invoiceNums = new Set(
                plan.transactions.filter(t => t.description.startsWith('Invoice')).map(t => t.num)
            );
            const paidNums = new Set(
                plan.transactions.filter(t => t.description.startsWith('Payment')).map(t => t.num)
            );
            const unpaid = [...invoiceNums].filter(n => !paidNums.has(n));
            expect(unpaid.length).toBeGreaterThanOrEqual(2);
            expect(unpaid.length).toBeLessThanOrEqual(4);
        });

        it('maps Income and Expenses parents for the tax estimator', () => {
            expect(plan.taxMappings).toEqual([
                { accountPath: 'Income', taxCategory: 'self_employment_income' },
                { accountPath: 'Expenses', taxCategory: 'business_expense' },
            ]);
        });

        it('invoices post to Accounts Receivable against Service Income', () => {
            const invoice = plan.transactions.find(t => t.description.startsWith('Invoice'))!;
            const ar = invoice.splits.find(s => s.accountPath === 'Assets:Accounts Receivable')!;
            const income = invoice.splits.find(s => s.accountPath === 'Income:Service Income')!;
            expect(ar.valueCents).toBeGreaterThan(0);
            expect(income.valueCents).toBe(-ar.valueCents);
        });
    });

    it('anchoring on a different day shifts dates but keeps structure', () => {
        const other = buildDemoSeedPlan('household', new Date('2026-03-02T00:00:00Z'));
        splitSum(other);
        expect(other.transactions.filter(t => t.description.includes('Paycheck')).length).toBe(26);
        expect(other.transactions.filter(t => t.description.includes('Rent')).length).toBe(12);
    });
});
