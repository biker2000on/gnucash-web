import { describe, it, expect } from 'vitest';
import {
    paymentRatio,
    allocatePaymentsToAccounts,
    PaymentLotSplit,
    PostingSplit,
} from '../cash-basis';

/**
 * Fixture: a posted customer invoice of $1,000 + $80 tax = $1,080.
 *   +1080 on A/R (post split, carries the lot)
 *   -600  on Income:Services
 *   -400  on Income:Products
 *   -80   on Liabilities:Sales Tax
 * GnuCash signs: A/R debit positive, income/tax credits negative.
 */
function invoicePostingSplits(txGuid = 'ptx1'): PostingSplit[] {
    return [
        { txGuid, accountGuid: 'ar', value: 1080, isPostSplit: true },
        { txGuid, accountGuid: 'inc-services', value: -600, isPostSplit: false },
        { txGuid, accountGuid: 'inc-products', value: -400, isPostSplit: false },
        { txGuid, accountGuid: 'tax-liab', value: -80, isPostSplit: false },
    ];
}

/**
 * Fixture: a posted vendor bill of $500.
 *   -500 on A/P (post split)
 *   +300 on Expenses:Rent
 *   +200 on Expenses:Supplies
 */
function billPostingSplits(txGuid = 'btx1'): PostingSplit[] {
    return [
        { txGuid, accountGuid: 'ap', value: -500, isPostSplit: true },
        { txGuid, accountGuid: 'exp-rent', value: 300, isPostSplit: false },
        { txGuid, accountGuid: 'exp-supplies', value: 200, isPostSplit: false },
    ];
}

describe('paymentRatio', () => {
    it('is the paid fraction for a customer invoice (payment credit vs A/R debit)', () => {
        // $540 payment against a $1,080 invoice: payment lot split = -540
        expect(paymentRatio(-540, 1080)).toBeCloseTo(0.5, 10);
    });

    it('is the paid fraction for a vendor bill (payment debit vs A/P credit)', () => {
        // $250 payment against a $500 bill: payment lot split = +250
        expect(paymentRatio(250, -500)).toBeCloseTo(0.5, 10);
    });

    it('is 1 for a full payment', () => {
        expect(paymentRatio(-1080, 1080)).toBe(1);
    });

    it('returns 0 when the post split value is zero', () => {
        expect(paymentRatio(-100, 0)).toBe(0);
    });

    it('goes negative for credit-note style adjustments', () => {
        expect(paymentRatio(108, 1080)).toBeCloseTo(-0.1, 10);
    });
});

describe('allocatePaymentsToAccounts', () => {
    it('allocates a full invoice payment to income and tax accounts by line totals', () => {
        const payments: PaymentLotSplit[] = [{ postTxnGuid: 'ptx1', value: -1080 }];
        const out = allocatePaymentsToAccounts(payments, invoicePostingSplits());

        // Raw GnuCash sign: income stays negative.
        expect(out.get('inc-services')).toBeCloseTo(-600, 6);
        expect(out.get('inc-products')).toBeCloseTo(-400, 6);
        expect(out.get('tax-liab')).toBeCloseTo(-80, 6);
        // The A/R post split itself is never allocated.
        expect(out.has('ar')).toBe(false);
    });

    it('allocates a partial payment pro-rata', () => {
        // 25% paid: $270 of $1,080
        const payments: PaymentLotSplit[] = [{ postTxnGuid: 'ptx1', value: -270 }];
        const out = allocatePaymentsToAccounts(payments, invoicePostingSplits());

        expect(out.get('inc-services')).toBeCloseTo(-150, 6);
        expect(out.get('inc-products')).toBeCloseTo(-100, 6);
        expect(out.get('tax-liab')).toBeCloseTo(-20, 6);

        // Recognized total equals the payment (opposite sign).
        const total = [...out.values()].reduce((s, v) => s + v, 0);
        expect(total).toBeCloseTo(-270, 6);
    });

    it('accumulates multiple payments against the same invoice', () => {
        const payments: PaymentLotSplit[] = [
            { postTxnGuid: 'ptx1', value: -540 },
            { postTxnGuid: 'ptx1', value: -540 },
        ];
        const out = allocatePaymentsToAccounts(payments, invoicePostingSplits());
        expect(out.get('inc-services')).toBeCloseTo(-600, 6);
        expect(out.get('inc-products')).toBeCloseTo(-400, 6);
    });

    it('handles vendor bill payments with flipped signs (expenses positive)', () => {
        // $250 of a $500 bill paid → half of each expense line recognized.
        const payments: PaymentLotSplit[] = [{ postTxnGuid: 'btx1', value: 250 }];
        const out = allocatePaymentsToAccounts(payments, billPostingSplits());

        expect(out.get('exp-rent')).toBeCloseTo(150, 6);
        expect(out.get('exp-supplies')).toBeCloseTo(100, 6);
        expect(out.has('ap')).toBe(false);
    });

    it('handles payments spanning multiple invoices (one lot split each)', () => {
        const splits = [...invoicePostingSplits('ptx1'), ...billPostingSplits('btx1')];
        const payments: PaymentLotSplit[] = [
            { postTxnGuid: 'ptx1', value: -1080 },
            { postTxnGuid: 'btx1', value: 500 },
        ];
        const out = allocatePaymentsToAccounts(payments, splits);
        expect(out.get('inc-services')).toBeCloseTo(-600, 6);
        expect(out.get('exp-rent')).toBeCloseTo(300, 6);
    });

    it('merges recognized amounts when invoices share an income account', () => {
        const splits: PostingSplit[] = [
            { txGuid: 'p1', accountGuid: 'ar', value: 100, isPostSplit: true },
            { txGuid: 'p1', accountGuid: 'inc-services', value: -100, isPostSplit: false },
            { txGuid: 'p2', accountGuid: 'ar', value: 200, isPostSplit: true },
            { txGuid: 'p2', accountGuid: 'inc-services', value: -200, isPostSplit: false },
        ];
        const payments: PaymentLotSplit[] = [
            { postTxnGuid: 'p1', value: -100 },
            { postTxnGuid: 'p2', value: -50 },
        ];
        const out = allocatePaymentsToAccounts(payments, splits);
        expect(out.get('inc-services')).toBeCloseTo(-150, 6);
    });

    it('skips payments whose posting transaction is unknown or degenerate', () => {
        const payments: PaymentLotSplit[] = [
            { postTxnGuid: 'missing', value: -100 },
            { postTxnGuid: 'zero', value: -100 },
        ];
        const splits: PostingSplit[] = [
            { txGuid: 'zero', accountGuid: 'ar', value: 0, isPostSplit: true },
            { txGuid: 'zero', accountGuid: 'inc-services', value: 0, isPostSplit: false },
        ];
        const out = allocatePaymentsToAccounts(payments, splits);
        expect(out.size).toBe(0);
    });

    it('credit notes reduce recognized income', () => {
        // A -$108 refund lot split (10% of the invoice) after a full payment.
        const payments: PaymentLotSplit[] = [
            { postTxnGuid: 'ptx1', value: -1080 },
            { postTxnGuid: 'ptx1', value: 108 },
        ];
        const out = allocatePaymentsToAccounts(payments, invoicePostingSplits());
        expect(out.get('inc-services')).toBeCloseTo(-540, 6);
        expect(out.get('inc-products')).toBeCloseTo(-360, 6);
    });
});
