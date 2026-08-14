/**
 * Trade-fee allocation tests — the pure core of @/lib/trade-fees.
 *
 * Covers: a single commission on a one-security ticket, several fee splits in
 * one transaction (commission + SEC fee + exchange fee), pro-rata sharing
 * across the per-lot sell splits a scrub produces, multi-security tickets,
 * zero-quantity splits taking no share, and transactions with no security leg.
 */

import { describe, it, expect } from 'vitest';
import { allocateTradeFees, type FeeAllocationSplit } from '@/lib/trade-fees';

const split = (over: Partial<FeeAllocationSplit> & { guid: string }): FeeAllocationSplit => ({
    txGuid: 'tx-1',
    accountType: 'STOCK',
    value: 0,
    quantity: 0,
    ...over,
});

describe('allocateTradeFees', () => {
    it('attaches a single commission to the security split of the trade', () => {
        const fees = allocateTradeFees([
            split({ guid: 'stock', accountType: 'STOCK', value: 1000, quantity: 10 }),
            split({ guid: 'cash', accountType: 'BANK', value: -1009.95, quantity: -1009.95 }),
            split({ guid: 'comm', accountType: 'EXPENSE', value: 9.95, quantity: 9.95 }),
        ]);
        expect(fees.get('stock')).toBeCloseTo(9.95, 6);
        expect(fees.has('cash')).toBe(false);
        expect(fees.has('comm')).toBe(false);
    });

    it('sums SEVERAL fee splits in one transaction', () => {
        const fees = allocateTradeFees([
            split({ guid: 'stock', accountType: 'STOCK', value: -5000, quantity: -50 }),
            split({ guid: 'cash', accountType: 'BANK', value: 4988.77, quantity: 4988.77 }),
            split({ guid: 'commission', accountType: 'EXPENSE', value: 6.95, quantity: 6.95 }),
            split({ guid: 'sec-fee', accountType: 'EXPENSE', value: 0.13, quantity: 0.13 }),
            split({ guid: 'exchange-fee', accountType: 'EXPENSE', value: 4.15, quantity: 4.15 }),
        ]);
        expect(fees.get('stock')).toBeCloseTo(11.23, 6);
    });

    it('pro-rates one ticket fee across the per-lot sell splits a scrub creates', () => {
        // One sale of 100 shares scrubbed into two lot splits, 25% / 75% by value.
        const fees = allocateTradeFees([
            split({ guid: 'sell-lot-a', accountType: 'STOCK', value: -500, quantity: -25 }),
            split({ guid: 'sell-lot-b', accountType: 'STOCK', value: -1500, quantity: -75 }),
            split({ guid: 'cash', accountType: 'BANK', value: 1990, quantity: 1990 }),
            split({ guid: 'comm', accountType: 'EXPENSE', value: 10, quantity: 10 }),
        ]);
        expect(fees.get('sell-lot-a')).toBeCloseTo(2.5, 6);
        expect(fees.get('sell-lot-b')).toBeCloseTo(7.5, 6);
        // The whole fee is distributed exactly once — never charged per split.
        expect((fees.get('sell-lot-a') ?? 0) + (fees.get('sell-lot-b') ?? 0)).toBeCloseTo(10, 6);
    });

    it('shares a combined-ticket fee across the securities by value', () => {
        const fees = allocateTradeFees([
            split({ guid: 'vti', accountType: 'STOCK', value: 3000, quantity: 12 }),
            split({ guid: 'bnd', accountType: 'MUTUAL', value: 1000, quantity: 14 }),
            split({ guid: 'cash', accountType: 'BANK', value: -4008, quantity: -4008 }),
            split({ guid: 'comm', accountType: 'EXPENSE', value: 8, quantity: 8 }),
        ]);
        expect(fees.get('vti')).toBeCloseTo(6, 6);
        expect(fees.get('bnd')).toBeCloseTo(2, 6);
    });

    it('uses the fee split VALUE, so a foreign-currency fee lands in trade currency', () => {
        // EUR commission account: quantity is 9 EUR, value is its USD amount.
        const fees = allocateTradeFees([
            split({ guid: 'stock', accountType: 'STOCK', value: 1000, quantity: 10 }),
            split({ guid: 'cash', accountType: 'BANK', value: -1009.9, quantity: -1009.9 }),
            split({ guid: 'comm-eur', accountType: 'EXPENSE', value: 9.9, quantity: 9 }),
        ]);
        expect(fees.get('stock')).toBeCloseTo(9.9, 6);
    });

    it('gives zero-quantity splits (gains offsets) no share of the fee', () => {
        const fees = allocateTradeFees([
            split({ guid: 'sell', accountType: 'STOCK', value: -1000, quantity: -10 }),
            split({ guid: 'gains-offset', accountType: 'STOCK', value: 300, quantity: 0 }),
            split({ guid: 'cash', accountType: 'BANK', value: 995, quantity: 995 }),
            split({ guid: 'comm', accountType: 'EXPENSE', value: 5, quantity: 5 }),
        ]);
        expect(fees.get('sell')).toBeCloseTo(5, 6);
        expect(fees.has('gains-offset')).toBe(false);
    });

    it('weights by shares when the security splits carry no value', () => {
        const fees = allocateTradeFees([
            split({ guid: 'in-a', accountType: 'STOCK', value: 0, quantity: 30 }),
            split({ guid: 'in-b', accountType: 'STOCK', value: 0, quantity: 10 }),
            split({ guid: 'cash', accountType: 'BANK', value: -20, quantity: -20 }),
            split({ guid: 'fee', accountType: 'EXPENSE', value: 20, quantity: 20 }),
        ]);
        expect(fees.get('in-a')).toBeCloseTo(15, 6);
        expect(fees.get('in-b')).toBeCloseTo(5, 6);
    });

    it('allocates nothing for fee-free trades or fees with no security leg', () => {
        expect(allocateTradeFees([
            split({ guid: 'stock', accountType: 'STOCK', value: 1000, quantity: 10 }),
            split({ guid: 'cash', accountType: 'BANK', value: -1000, quantity: -1000 }),
        ]).size).toBe(0);

        // A dividend with a fee: no security leg, so the fee stays an expense.
        expect(allocateTradeFees([
            split({ guid: 'cash', accountType: 'BANK', value: 95, quantity: 95 }),
            split({ guid: 'income', accountType: 'INCOME', value: -100, quantity: -100 }),
            split({ guid: 'fee', accountType: 'EXPENSE', value: 5, quantity: 5 }),
        ]).size).toBe(0);
    });

    it('keeps transactions independent', () => {
        const fees = allocateTradeFees([
            split({ txGuid: 'tx-1', guid: 'a', accountType: 'STOCK', value: 1000, quantity: 10 }),
            split({ txGuid: 'tx-1', guid: 'a-fee', accountType: 'EXPENSE', value: 4, quantity: 4 }),
            split({ txGuid: 'tx-2', guid: 'b', accountType: 'STOCK', value: 2000, quantity: 20 }),
            split({ txGuid: 'tx-2', guid: 'b-fee', accountType: 'EXPENSE', value: 7, quantity: 7 }),
        ]);
        expect(fees.get('a')).toBeCloseTo(4, 6);
        expect(fees.get('b')).toBeCloseTo(7, 6);
    });
});
