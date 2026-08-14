/**
 * Trade-fee classification + allocation tests — the pure core of
 * @/lib/trade-fees.
 *
 * The load-bearing behaviours here are the two that keep the
 * never-both/never-neither invariant honest:
 *  - a charge is only capitalized when its ACCOUNT PATH positively reads as a
 *    trade fee (accrued bond interest, margin interest and withheld foreign
 *    tax must never become basis), and
 *  - a fee whose account is tax-mapped is left to the deduction it already
 *    feeds, never capitalized on top of it.
 * Plus: exact-to-the-cent apportionment, and the mixed/unvalued tickets whose
 * fees cannot be attributed at all.
 */

import { describe, it, expect } from 'vitest';
import {
    allocateTradeFees,
    apportionCents,
    classifyFeeAccount,
    deductibleFeeAccounts,
    type FeeAllocationSplit,
} from '@/lib/trade-fees';
import { TAX_CATEGORY_TREATMENT } from '@/lib/tax/deduction-categories';
import { TAX_CATEGORIES } from '@/lib/tax/types';

const split = (over: Partial<FeeAllocationSplit> & { guid: string }): FeeAllocationSplit => ({
    txGuid: 'tx-1',
    accountGuid: over.guid,
    accountType: 'STOCK',
    accountPath: 'Assets:Brokerage:VTI',
    value: 0,
    quantity: 0,
    txDescription: 'Buy 10 VTI',
    txDate: '2024-03-15T00:00:00.000Z',
    ...over,
});

const commission = (over: Partial<FeeAllocationSplit> = {}): FeeAllocationSplit => split({
    guid: 'comm',
    accountType: 'EXPENSE',
    accountPath: 'Expenses:Investments:Commissions',
    value: 9.95,
    quantity: 9.95,
    ...over,
});

const centSum = (values: number[]): number =>
    values.reduce((sum, v) => sum + Math.round(v * 100), 0);

/* ------------------------------------------------------------------ */
/* Classification — account_type is NOT the classifier                 */
/* ------------------------------------------------------------------ */

describe('classifyFeeAccount', () => {
    it('recognizes commission / fee / brokerage accounts', () => {
        expect(classifyFeeAccount('Expenses:Investments:Commissions')).toBe('fee');
        expect(classifyFeeAccount('Expenses:Brokerage Fees')).toBe('fee');
        expect(classifyFeeAccount('Expenses:Trading:SEC Fee')).toBe('fee');
        expect(classifyFeeAccount('Expenses:Brokerage')).toBe('fee');
    });

    it('refuses the charges that are NOT basis', () => {
        expect(classifyFeeAccount('Expenses:Investments:Accrued Interest')).toBe('not-fee');
        expect(classifyFeeAccount('Expenses:Margin Interest')).toBe('not-fee');
        expect(classifyFeeAccount('Expenses:Taxes:Foreign Tax Withheld')).toBe('not-fee');
    });

    it('flags a path reading as BOTH a fee and a non-fee charge as ambiguous', () => {
        // Deny still wins the outcome, but this is the one refusal that could
        // otherwise drop a genuine fee with no signal at all.
        expect(classifyFeeAccount('Expenses:Brokerage:Interest Fees')).toBe('ambiguous');
        expect(classifyFeeAccount('Expenses:Brokerage Premium')).toBe('ambiguous');
        expect(classifyFeeAccount('Expenses:Fees:Transaction Tax')).toBe('ambiguous');
    });

    it('reports anything it cannot place rather than guessing', () => {
        expect(classifyFeeAccount('Expenses:Investment Expenses')).toBe('unrecognized');
        expect(classifyFeeAccount('Expenses:Misc')).toBe('unrecognized');
        expect(classifyFeeAccount('')).toBe('unrecognized');
    });
});

/* ------------------------------------------------------------------ */
/* Exact apportionment                                                 */
/* ------------------------------------------------------------------ */

describe('apportionCents', () => {
    it('preserves the total EXACTLY for weights that do not divide evenly', () => {
        const parts = apportionCents(100, [1, 4, 1]);
        expect(parts).toEqual([17, 67, 16]);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    });

    it('preserves the total for thirds, and for a negative (rebate) total', () => {
        expect(apportionCents(100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100);
        expect(apportionCents(-995, [3, 7]).reduce((a, b) => a + b, 0)).toBe(-995);
    });

    it('never produces a negative share for a positive total', () => {
        for (const parts of [
            apportionCents(3, [1, 1, 1, 1, 1, 1, 1]),
            apportionCents(1, [1000000, 1, 1]),
        ]) {
            expect(parts.every(p => p >= 0)).toBe(true);
        }
    });
});

/* ------------------------------------------------------------------ */
/* Allocation                                                          */
/* ------------------------------------------------------------------ */

describe('allocateTradeFees', () => {
    it('attaches a single commission to the security split of the trade', () => {
        const { fees, warnings } = allocateTradeFees([
            split({ guid: 'stock', accountType: 'STOCK', value: 1000, quantity: 10 }),
            split({ guid: 'cash', accountType: 'BANK', value: -1009.95, quantity: -1009.95 }),
            commission(),
        ]);
        expect(fees.get('stock')).toBe(9.95);
        expect(fees.has('cash')).toBe(false);
        expect(warnings).toEqual([]);
    });

    it('sums SEVERAL fee splits in one transaction', () => {
        const { fees } = allocateTradeFees([
            split({ guid: 'stock', accountType: 'STOCK', value: -5000, quantity: -50 }),
            split({ guid: 'cash', accountType: 'BANK', value: 4988.77, quantity: 4988.77 }),
            commission({ guid: 'commission', value: 6.95 }),
            commission({ guid: 'sec-fee', accountPath: 'Expenses:Trading:SEC Fee', value: 0.13 }),
            commission({ guid: 'exch-fee', accountPath: 'Expenses:Trading:Exchange Fee', value: 4.15 }),
        ]);
        expect(fees.get('stock')).toBe(11.23);
    });

    it('pro-rates one ticket fee across the per-lot sell splits a scrub creates', () => {
        // One sale of 100 shares scrubbed into two lot splits, 25% / 75% by value.
        const { fees } = allocateTradeFees([
            split({ guid: 'sell-lot-a', accountType: 'STOCK', value: -500, quantity: -25 }),
            split({ guid: 'sell-lot-b', accountType: 'STOCK', value: -1500, quantity: -75 }),
            split({ guid: 'cash', accountType: 'BANK', value: 1990, quantity: 1990 }),
            commission({ value: 10 }),
        ]);
        expect(fees.get('sell-lot-a')).toBe(2.5);
        expect(fees.get('sell-lot-b')).toBe(7.5);
    });

    it('distributes an indivisible fee to the LAST cent, never losing the residual', () => {
        // Weights 1:4:1 over $1.00 — the case plain floating point drops to
        // 0.9999999999999999.
        const { fees } = allocateTradeFees([
            split({ guid: 'a', accountType: 'STOCK', value: -100, quantity: -1 }),
            split({ guid: 'b', accountType: 'STOCK', value: -400, quantity: -4 }),
            split({ guid: 'c', accountType: 'STOCK', value: -100, quantity: -1 }),
            split({ guid: 'cash', accountType: 'BANK', value: 599, quantity: 599 }),
            commission({ value: 1 }),
        ]);
        expect(fees.get('a')).toBe(0.17);
        expect(fees.get('b')).toBe(0.67);
        expect(fees.get('c')).toBe(0.16);
        // Exact, not approximately: the ticket fee is neither lost nor duplicated.
        expect(centSum([...fees.values()])).toBe(100);
    });

    it('shares a combined-ticket fee across the securities by value', () => {
        const { fees } = allocateTradeFees([
            split({ guid: 'vti', accountType: 'STOCK', value: 3000, quantity: 12 }),
            split({ guid: 'bnd', accountType: 'MUTUAL', value: 1000, quantity: 14 }),
            split({ guid: 'cash', accountType: 'BANK', value: -4008, quantity: -4008 }),
            commission({ value: 8 }),
        ]);
        expect(fees.get('vti')).toBe(6);
        expect(fees.get('bnd')).toBe(2);
        expect(centSum([...fees.values()])).toBe(800);
    });

    it('uses the fee split VALUE, so a foreign-currency fee lands in trade currency', () => {
        // EUR commission account: quantity is 9 EUR, value is its USD amount.
        const { fees } = allocateTradeFees([
            split({ guid: 'stock', accountType: 'STOCK', value: 1000, quantity: 10 }),
            split({ guid: 'cash', accountType: 'BANK', value: -1009.9, quantity: -1009.9 }),
            commission({ guid: 'comm-eur', value: 9.9, quantity: 9 }),
        ]);
        expect(fees.get('stock')).toBe(9.9);
    });

    it('gives zero-quantity splits (gains offsets) no share of the fee', () => {
        const { fees } = allocateTradeFees([
            split({ guid: 'sell', accountType: 'STOCK', value: -1000, quantity: -10 }),
            split({ guid: 'gains-offset', accountType: 'STOCK', value: 300, quantity: 0 }),
            split({ guid: 'cash', accountType: 'BANK', value: 995, quantity: 995 }),
            commission({ value: 5 }),
        ]);
        expect(fees.get('sell')).toBe(5);
        expect(fees.has('gains-offset')).toBe(false);
    });

    it('keeps transactions independent', () => {
        const { fees } = allocateTradeFees([
            split({ txGuid: 'tx-1', guid: 'a', accountType: 'STOCK', value: 1000, quantity: 10 }),
            commission({ txGuid: 'tx-1', guid: 'a-fee', value: 4 }),
            split({ txGuid: 'tx-2', guid: 'b', accountType: 'STOCK', value: 2000, quantity: 20 }),
            commission({ txGuid: 'tx-2', guid: 'b-fee', value: 7 }),
        ]);
        expect(fees.get('a')).toBe(4);
        expect(fees.get('b')).toBe(7);
    });
});

/* ------------------------------------------------------------------ */
/* B1 — charges that must NEVER become basis                           */
/* ------------------------------------------------------------------ */

describe('allocateTradeFees — non-fee charges on a trade', () => {
    it('does not capitalize ACCRUED INTEREST on a bond purchase', () => {
        // Accrued interest is an offset to interest income, not basis.
        const { fees, warnings } = allocateTradeFees([
            split({ guid: 'bond', accountType: 'STOCK', value: 9800, quantity: 10 }),
            split({ guid: 'cash', accountType: 'BANK', value: -9930, quantity: -9930 }),
            split({
                guid: 'accrued',
                accountType: 'EXPENSE',
                accountPath: 'Expenses:Investments:Accrued Interest',
                value: 130,
                quantity: 130,
            }),
        ]);
        expect(fees.size).toBe(0);
        // Confidently not a fee — no noise for the user to triage.
        expect(warnings).toEqual([]);
    });

    it('does not capitalize margin interest bundled onto the same ticket', () => {
        const { fees } = allocateTradeFees([
            split({ guid: 'stock', accountType: 'STOCK', value: 1000, quantity: 10 }),
            split({ guid: 'cash', accountType: 'BANK', value: -1030, quantity: -1030 }),
            split({
                guid: 'margin',
                accountType: 'EXPENSE',
                accountPath: 'Expenses:Margin Interest',
                value: 30,
                quantity: 30,
            }),
        ]);
        expect(fees.size).toBe(0);
    });

    it('does not capitalize foreign tax withheld on a REINVESTED dividend', () => {
        // A security leg is present here (unlike a cash dividend), so the old
        // account_type-only rule would have capitalized the withholding.
        const { fees } = allocateTradeFees([
            split({ guid: 'shares', accountType: 'MUTUAL', value: 85, quantity: 1.2 }),
            split({ guid: 'income', accountType: 'INCOME', value: -100, quantity: -100 }),
            split({
                guid: 'fortax',
                accountType: 'EXPENSE',
                accountPath: 'Expenses:Taxes:Foreign Tax Withheld',
                value: 15,
                quantity: 15,
            }),
        ]);
        expect(fees.size).toBe(0);
    });

    it('reports — and does not capitalize — an allow/deny collision', () => {
        const { fees, warnings } = allocateTradeFees([
            split({ guid: 'stock', accountType: 'STOCK', value: 1000, quantity: 10 }),
            split({ guid: 'cash', accountType: 'BANK', value: -1009, quantity: -1009 }),
            commission({ guid: 'both', accountPath: 'Expenses:Fees:Transaction Tax', value: 9 }),
        ]);
        expect(fees.size).toBe(0);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('BOTH a trade fee and a non-fee charge');
    });

    it('reports — and does not capitalize — an expense it cannot classify', () => {
        const { fees, warnings } = allocateTradeFees([
            split({ guid: 'stock', accountType: 'STOCK', value: 1000, quantity: 10 }),
            split({ guid: 'cash', accountType: 'BANK', value: -1012, quantity: -1012 }),
            split({
                guid: 'misc',
                accountType: 'EXPENSE',
                accountPath: 'Expenses:Investment Expenses',
                value: 12,
                quantity: 12,
            }),
        ]);
        expect(fees.size).toBe(0);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Expenses:Investment Expenses');
        expect(warnings[0]).toContain('NOT added to cost basis');
    });
});

/* ------------------------------------------------------------------ */
/* B2 — never both: a tax-mapped fee is already a deduction            */
/* ------------------------------------------------------------------ */

describe('allocateTradeFees — fees already claimed as a deduction', () => {
    const trade = (): FeeAllocationSplit[] => [
        split({ guid: 'stock', accountType: 'STOCK', value: 1000, quantity: 10 }),
        split({ guid: 'cash', accountType: 'BANK', value: -1009.95, quantity: -1009.95 }),
        commission({ accountGuid: 'comm-acct' }),
    ];

    it('does NOT capitalize a fee whose account is mapped to a tax category', () => {
        const { fees, warnings } = allocateTradeFees(trade(), new Set(['comm-acct']));
        expect(fees.size).toBe(0);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('already deducts it from taxable income');
    });

    it('DOES capitalize the same fee when its account is not mapped', () => {
        const { fees, warnings } = allocateTradeFees(trade(), new Set(['some-other-account']));
        expect(fees.get('stock')).toBe(9.95);
        expect(warnings).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* Which mappings actually suppress capitalization                     */
/* ------------------------------------------------------------------ */

describe('deductibleFeeAccounts', () => {
    const mapped = (category: string) => deductibleFeeAccounts(new Map([['comm', category]]));

    it('suppresses only categories that really lower taxable income', () => {
        expect(mapped('business_expense').has('comm')).toBe(true);
        expect(mapped('other_deduction').has('comm')).toBe(true);
        expect(mapped('charitable_donation').has('comm')).toBe(true);
        // State taxes paid are a payment AND a Schedule A deduction.
        expect(mapped('state_estimated_tax_payment').has('comm')).toBe(true);
    });

    it('does NOT suppress payment, informational, income or excluded mappings', () => {
        // These buy no deduction, so refusing to capitalize would leave the
        // fee counted nowhere — the original H2 omission, returning.
        expect(mapped('estimated_tax_payment').has('comm')).toBe(false);
        expect(mapped('federal_withholding').has('comm')).toBe(false);
        expect(mapped('education_529_contribution').has('comm')).toBe(false);
        expect(mapped('esa_contribution').has('comm')).toBe(false);
        expect(mapped('roth_ira_contribution').has('comm')).toBe(false);
        expect(mapped('fica_medicare').has('comm')).toBe(false);
        expect(mapped('interest_income').has('comm')).toBe(false);
        expect(mapped('exclude').has('comm')).toBe(false);
    });

    it('treats an unmapped account and an unknown category as not deducting', () => {
        expect(deductibleFeeAccounts(undefined).size).toBe(0);
        expect(mapped('some_future_category').has('comm')).toBe(false);
    });

    it('states a treatment for EVERY tax category (a new one must not default)', () => {
        // TAX_CATEGORY_TREATMENT is a total Record over TaxCategory, so this
        // is really a compile-time guarantee; the runtime check catches a
        // category added to the list without a treatment row.
        for (const category of TAX_CATEGORIES) {
            expect(TAX_CATEGORY_TREATMENT[category]).toBeDefined();
        }
        expect(Object.keys(TAX_CATEGORY_TREATMENT)).toHaveLength(TAX_CATEGORIES.length);
    });
});

/* ------------------------------------------------------------------ */
/* Warning cap                                                         */
/* ------------------------------------------------------------------ */

describe('allocateTradeFees — warning volume', () => {
    it('caps the list but reports how many notices it suppressed', () => {
        // 30 distinct trades, each with an unclassifiable expense.
        const splits = Array.from({ length: 30 }, (_, i) => [
            split({
                txGuid: `tx-${i}`, guid: `stock-${i}`, accountType: 'STOCK',
                value: 1000, quantity: 10, txDescription: `Buy lot ${i}`,
            }),
            commission({
                txGuid: `tx-${i}`, guid: `misc-${i}`,
                accountPath: `Expenses:Investment Expenses ${i}`, value: 5,
            }),
        ]).flat();

        const { fees, warnings } = allocateTradeFees(splits);
        expect(fees.size).toBe(0);
        expect(warnings).toHaveLength(26); // 25 notices + the suppression summary
        expect(warnings[25]).toBe(
            '5 further trade-fee notices were suppressed (only the first 25 are listed). '
            + 'Resolve these and re-run to see the rest.',
        );
    });

    it('adds no summary line when nothing was suppressed', () => {
        const { warnings } = allocateTradeFees([
            split({ guid: 'stock', accountType: 'STOCK', value: 1000, quantity: 10 }),
            commission({ accountPath: 'Expenses:Investment Expenses', value: 5 }),
        ]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).not.toContain('suppressed');
    });
});

/* ------------------------------------------------------------------ */
/* Tickets whose fee cannot be attributed                              */
/* ------------------------------------------------------------------ */

describe('allocateTradeFees — unattributable tickets', () => {
    it('refuses to spread one fee across an in-kind TRANSFER (mixed direction)', () => {
        // Shares leave account A and arrive in account B in one transaction.
        // Charging part of the ACAT fee to the destination leg would quietly
        // inflate the transferred lot's basis.
        const { fees, warnings } = allocateTradeFees([
            split({ guid: 'out', accountType: 'STOCK', value: 0, quantity: -10 }),
            split({ guid: 'in', accountType: 'STOCK', value: 0, quantity: 10 }),
            split({ guid: 'cash', accountType: 'BANK', value: -75, quantity: -75 }),
            commission({ guid: 'acat', accountPath: 'Expenses:Brokerage Fees', value: 75 }),
        ]);
        expect(fees.size).toBe(0);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('both adds and removes shares');
    });

    it('refuses a same-ticket buy AND sell', () => {
        const { fees, warnings } = allocateTradeFees([
            split({ guid: 'buy', accountType: 'STOCK', value: 2000, quantity: 20 }),
            split({ guid: 'sell', accountType: 'MUTUAL', value: -2000, quantity: -30 }),
            commission({ value: 12 }),
        ]);
        expect(fees.size).toBe(0);
        expect(warnings[0]).toContain('both adds and removes shares');
    });

    it('refuses a ticket whose security splits carry no value', () => {
        const { fees, warnings } = allocateTradeFees([
            split({ guid: 'in-a', accountType: 'STOCK', value: 0, quantity: 30 }),
            split({ guid: 'in-b', accountType: 'STOCK', value: 0, quantity: 10 }),
            split({ guid: 'cash', accountType: 'BANK', value: -20, quantity: -20 }),
            commission({ value: 20 }),
        ]);
        expect(fees.size).toBe(0);
        expect(warnings[0]).toContain('carry no value');
    });

    it('allocates nothing for fee-free trades or fees with no security leg', () => {
        expect(allocateTradeFees([
            split({ guid: 'stock', accountType: 'STOCK', value: 1000, quantity: 10 }),
            split({ guid: 'cash', accountType: 'BANK', value: -1000, quantity: -1000 }),
        ]).fees.size).toBe(0);

        // A CASH dividend with a fee: no security leg, so the fee stays an expense.
        const cashDividend = allocateTradeFees([
            split({ guid: 'cash', accountType: 'BANK', value: 95, quantity: 95 }),
            split({ guid: 'income', accountType: 'INCOME', value: -100, quantity: -100 }),
            commission({ value: 5 }),
        ]);
        expect(cashDividend.fees.size).toBe(0);
        expect(cashDividend.warnings).toEqual([]);
    });
});
