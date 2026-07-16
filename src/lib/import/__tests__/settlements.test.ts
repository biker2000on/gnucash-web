import { describe, it, expect } from 'vitest';
import {
    parseStripeSettlementCsv,
    parseSquareSettlementCsv,
    parsePaypalSettlementCsv,
    parseShopifySettlementCsv,
    parseSettlementCsv,
    buildSettlementSplits,
    dedupeStamp,
    parseSettlementDate,
    type SettlementRecord,
} from '../settlements';
import { IMPORT_LOCALES } from '../parse-locale';

const rec = (over: Partial<SettlementRecord>): SettlementRecord => ({
    date: '2025-01-15',
    kind: 'sale',
    gross: 100,
    fee: 3.2,
    net: 96.8,
    reference: 'ref',
    description: '',
    currency: 'USD',
    row: 2,
    ...over,
});

/* ------------------------------------------------------------------ */
/* Split construction                                                   */
/* ------------------------------------------------------------------ */

describe('buildSettlementSplits', () => {
    it('sale: clearing net + fee expense / income gross, sums to zero', () => {
        const splits = buildSettlementSplits(rec({}));
        expect(splits).toEqual([
            { role: 'clearing', amount: 96.8 },
            { role: 'fees', amount: 3.2 },
            { role: 'income', amount: -100 },
        ]);
        expect(splits.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(0, 10);
    });

    it('refund reverses the sale (contra income debit, fee credit)', () => {
        const splits = buildSettlementSplits(
            rec({ kind: 'refund', gross: -50, fee: -1.45, net: -48.55 })
        );
        expect(splits).toEqual([
            { role: 'clearing', amount: -48.55 },
            { role: 'fees', amount: -1.45 },
            { role: 'income', amount: 50 },
        ]);
    });

    it('payout: debit bank, credit clearing', () => {
        const splits = buildSettlementSplits(
            rec({ kind: 'payout', gross: 0, fee: 0, net: -96.8 })
        );
        expect(splits).toEqual([
            { role: 'clearing', amount: -96.8 },
            { role: 'bank', amount: 96.8 },
        ]);
    });

    it('fee_only: clearing credit vs fee expense debit; zero legs dropped', () => {
        const splits = buildSettlementSplits(
            rec({ kind: 'fee_only', gross: 0, fee: 2, net: -2 })
        );
        expect(splits).toEqual([
            { role: 'clearing', amount: -2 },
            { role: 'fees', amount: 2 },
        ]);
    });

    it('zero-amount records produce no splits', () => {
        expect(buildSettlementSplits(rec({ gross: 0, fee: 0, net: 0 }))).toEqual([]);
    });
});

describe('dedupeStamp', () => {
    it('stamps as <source>:<reference> and null without a reference', () => {
        expect(dedupeStamp('stripe', 'txn_123')).toBe('stripe:txn_123');
        expect(dedupeStamp('paypal', '  ')).toBeNull();
    });
});

describe('parseSettlementDate', () => {
    it('accepts plain dates and timestamps', () => {
        expect(parseSettlementDate('2025-01-15')).toBe('2025-01-15');
        expect(parseSettlementDate('2025-01-15 10:23:00')).toBe('2025-01-15');
        expect(parseSettlementDate('01/15/2025')).toBe('2025-01-15');
        expect(parseSettlementDate('nonsense')).toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/* Stripe                                                               */
/* ------------------------------------------------------------------ */

const STRIPE_HEADER = 'id,Type,Created (UTC),Amount,Fee,Net,Currency,Description';

describe('parseStripeSettlementCsv', () => {
    it('normalizes charges, refunds, and payouts', () => {
        const csv = [
            STRIPE_HEADER,
            'txn_1,charge,2025-01-15 10:00,100.00,3.20,96.80,usd,Invoice 42',
            'txn_2,refund,2025-01-16 09:00,-50.00,0.00,-50.00,usd,Refund 42',
            'txn_3,payout,2025-01-17 08:00,-146.80,0.00,-146.80,usd,STRIPE PAYOUT',
        ].join('\n');
        const result = parseStripeSettlementCsv(csv);

        expect(result.errors).toEqual([]);
        expect(result.records).toHaveLength(3);
        expect(result.records[0]).toMatchObject({
            date: '2025-01-15',
            kind: 'sale',
            gross: 100,
            fee: 3.2,
            net: 96.8,
            reference: 'txn_1',
            currency: 'USD',
        });
        expect(result.records[1]).toMatchObject({
            kind: 'refund',
            gross: -50,
            fee: 0,
            net: -50,
        });
        expect(result.records[2]).toMatchObject({ kind: 'payout', net: -146.8, gross: 0, fee: 0 });
        expect(result.dateRange).toEqual({ start: '2025-01-15', end: '2025-01-17' });
    });

    it('reshapes standalone stripe_fee rows onto the fee leg', () => {
        const csv = [STRIPE_HEADER, 'txn_9,stripe_fee,2025-01-20,-2.00,0.00,-2.00,usd,Billing'].join('\n');
        const r = parseStripeSettlementCsv(csv).records[0];
        expect(r).toMatchObject({ kind: 'fee_only', gross: 0, fee: 2, net: -2 });
        expect(buildSettlementSplits(r)).toEqual([
            { role: 'clearing', amount: -2 },
            { role: 'fees', amount: 2 },
        ]);
    });

    it('rejects rows where net + fee != gross', () => {
        const csv = [STRIPE_HEADER, 'txn_1,charge,2025-01-15,100.00,3.20,90.00,usd,Broken'].join('\n');
        const result = parseStripeSettlementCsv(csv);
        expect(result.records).toEqual([]);
        expect(result.errors[0].message).toContain('do not reconcile');
    });

    it('fails cleanly when the header is missing', () => {
        const result = parseStripeSettlementCsv('a,b\n1,2');
        expect(result.records).toEqual([]);
        expect(result.errors[0].message).toContain('Stripe header');
    });
});

/* ------------------------------------------------------------------ */
/* Square                                                               */
/* ------------------------------------------------------------------ */

const SQUARE_HEADER =
    'Date,Gross Sales,Discounts,Net Sales,Tax,Tip,Fees,Net Total,Transaction ID,Description';

describe('parseSquareSettlementCsv', () => {
    it('computes gross from net sales + tax + tip; fee from negative Fees', () => {
        const csv = [
            SQUARE_HEADER,
            '01/15/2025,$110.00,-$10.00,$100.00,$8.00,$2.00,-$3.19,$106.81,SQ123,Lunch order',
        ].join('\n');
        const result = parseSquareSettlementCsv(csv);
        expect(result.errors).toEqual([]);
        expect(result.records[0]).toMatchObject({
            date: '2025-01-15',
            kind: 'sale',
            gross: 110, // 100 net sales + 8 tax + 2 tip
            fee: 3.19,
            net: 106.81,
            reference: 'SQ123',
        });
    });

    it('classifies negative rows as refunds with the fee returned', () => {
        const csv = [
            SQUARE_HEADER,
            '01/16/2025,-$55.00,$0.00,-$55.00,$0.00,$0.00,$1.60,-$53.40,SQ124,Refund',
        ].join('\n');
        const r = parseSquareSettlementCsv(csv).records[0];
        expect(r).toMatchObject({ kind: 'refund', gross: -55, fee: -1.6, net: -53.4 });
    });

    it('fails cleanly when the header is missing', () => {
        const result = parseSquareSettlementCsv('x,y\n1,2');
        expect(result.errors[0].message).toContain('Square header');
    });
});

/* ------------------------------------------------------------------ */
/* PayPal                                                               */
/* ------------------------------------------------------------------ */

const PAYPAL_HEADER = 'Date,Name,Type,Status,Currency,Gross,Fee,Net,Transaction ID';

describe('parsePaypalSettlementCsv', () => {
    it('imports Completed rows only and normalizes the negative Fee', () => {
        const csv = [
            PAYPAL_HEADER,
            '01/15/2025,Alice,Express Checkout Payment,Completed,USD,100.00,-3.49,96.51,PP1',
            '01/15/2025,Bob,Express Checkout Payment,Pending,USD,40.00,-1.20,38.80,PP2',
            '01/16/2025,Carol,Payment Refund,Completed,USD,-25.00,0.88,-24.12,PP3',
            '01/17/2025,,General Withdrawal,Completed,USD,-96.51,0.00,-96.51,PP4',
        ].join('\n');
        const result = parsePaypalSettlementCsv(csv);

        expect(result.records).toHaveLength(3);
        expect(result.statusSkipped).toBe(1);
        expect(result.warnings.some((w) => w.includes('non-Completed'))).toBe(true);

        expect(result.records[0]).toMatchObject({
            kind: 'sale',
            gross: 100,
            fee: 3.49,
            net: 96.51,
            reference: 'PP1',
            description: 'Alice',
        });
        expect(result.records[1]).toMatchObject({
            kind: 'refund',
            gross: -25,
            fee: -0.88,
            net: -24.12,
        });
        expect(result.records[2]).toMatchObject({ kind: 'payout', net: -96.51, gross: 0, fee: 0 });
    });

    it('fails cleanly when the header is missing', () => {
        const result = parsePaypalSettlementCsv('x,y\n1,2');
        expect(result.errors[0].message).toContain('PayPal header');
    });
});

/* ------------------------------------------------------------------ */
/* Shopify                                                              */
/* ------------------------------------------------------------------ */

const SHOPIFY_HEADER = 'Transaction Date,Type,Order,Amount,Fee,Net';

describe('parseShopifySettlementCsv', () => {
    it('normalizes charges, refunds, and payout rows', () => {
        const csv = [
            SHOPIFY_HEADER,
            '2025-01-15,charge,#1001,100.00,2.90,97.10',
            '2025-01-16,refund,#1001,-50.00,0.00,-50.00',
            '2025-01-17,payout,,-47.10,0.00,-47.10',
        ].join('\n');
        const result = parseShopifySettlementCsv(csv);

        expect(result.errors).toEqual([]);
        expect(result.records[0]).toMatchObject({
            kind: 'sale',
            gross: 100,
            fee: 2.9,
            net: 97.1,
            reference: '#1001/sale',
        });
        expect(result.records[1]).toMatchObject({
            kind: 'refund',
            gross: -50,
            net: -50,
            reference: '#1001/refund',
        });
        expect(result.records[2]).toMatchObject({ kind: 'payout', net: -47.1 });
        // Charge and refund on the SAME order get distinct dedupe stamps.
        expect(dedupeStamp('shopify', result.records[0].reference)).not.toBe(
            dedupeStamp('shopify', result.records[1].reference)
        );
    });

    it('accepts the payout summary export as payout-only rows', () => {
        const csv = ['Payout Date,Status,Total', '2025-01-17,paid,147.10'].join('\n');
        const result = parseShopifySettlementCsv(csv);
        expect(result.records).toHaveLength(1);
        expect(result.records[0]).toMatchObject({ kind: 'payout', net: -147.1 });
        expect(result.warnings.some((w) => w.includes('SUMMARY'))).toBe(true);
    });

    it('fails cleanly when neither header matches', () => {
        const result = parseShopifySettlementCsv('x,y\n1,2');
        expect(result.errors[0].message).toContain('Shopify header');
    });
});

/* ------------------------------------------------------------------ */
/* Dispatcher + locale                                                  */
/* ------------------------------------------------------------------ */

describe('parseSettlementCsv', () => {
    it('dispatches by source', () => {
        const csv = [STRIPE_HEADER, 'txn_1,charge,2025-01-15,10.00,0.59,9.41,usd,Sale'].join('\n');
        expect(parseSettlementCsv('stripe', csv).records).toHaveLength(1);
    });

    it('parses EU locale amounts and day-first dates', () => {
        const csv = [
            STRIPE_HEADER,
            'txn_1,charge,15/01/2025,"1.234,56","35,80","1.198,76",eur,Sale',
        ].join('\n');
        const result = parseSettlementCsv('stripe', csv, IMPORT_LOCALES.eu);
        expect(result.errors).toEqual([]);
        expect(result.records[0]).toMatchObject({
            date: '2025-01-15',
            gross: 1234.56,
            fee: 35.8,
            net: 1198.76,
            currency: 'EUR',
        });
    });

    it('warns on mixed currencies', () => {
        const csv = [
            STRIPE_HEADER,
            'txn_1,charge,2025-01-15,10.00,0.59,9.41,usd,Sale',
            'txn_2,charge,2025-01-15,10.00,0.59,9.41,eur,Sale',
        ].join('\n');
        const result = parseSettlementCsv('stripe', csv);
        expect(result.warnings.some((w) => w.includes('mixes currencies'))).toBe(true);
    });
});
