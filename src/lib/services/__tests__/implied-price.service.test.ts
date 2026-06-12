/**
 * Implied price recording tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    accountsFindMany: vi.fn(),
    pricesFindFirst: vi.fn(),
    pricesCreate: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    default: {
        accounts: { findMany: mocks.accountsFindMany },
        prices: { findFirst: mocks.pricesFindFirst, create: mocks.pricesCreate },
    },
}));

import { impliedPriceFraction, recordImpliedPrices } from '../implied-price.service';

const STOCK_GUID = 'a'.repeat(32);
const CASH_GUID = 'b'.repeat(32);
const COMMODITY_GUID = 'c'.repeat(32);
const USD_GUID = 'd'.repeat(32);

describe('impliedPriceFraction', () => {
    it('computes value/quantity as a reduced fraction', () => {
        // $1,500.00 for 10 shares -> 150/1
        const f = impliedPriceFraction({
            account_guid: STOCK_GUID,
            value_num: 150000, value_denom: 100,
            quantity_num: 100000, quantity_denom: 10000,
        });
        expect(f).toEqual({ num: 150n, denom: 1n });
    });

    it('handles fractional shares exactly', () => {
        // $408.06 for 1.0001 shares -> 4080600/10001... reduced
        const f = impliedPriceFraction({
            account_guid: STOCK_GUID,
            value_num: 40806, value_denom: 100,
            quantity_num: 10001, quantity_denom: 10000,
        });
        expect(f).not.toBeNull();
        expect(Number(f!.num) / Number(f!.denom)).toBeCloseTo(408.02, 2);
    });

    it('returns null for zero value (the desktop $0-price bug)', () => {
        expect(impliedPriceFraction({
            account_guid: STOCK_GUID,
            value_num: 0, value_denom: 100,
            quantity_num: 5331102, quantity_denom: 10000,
        })).toBeNull();
    });

    it('returns null for zero quantity', () => {
        expect(impliedPriceFraction({
            account_guid: STOCK_GUID,
            value_num: 100, value_denom: 100,
            quantity_num: 0, quantity_denom: 10000,
        })).toBeNull();
    });

    it('is positive regardless of sign (sells)', () => {
        const f = impliedPriceFraction({
            account_guid: STOCK_GUID,
            value_num: -150000, value_denom: 100,
            quantity_num: -100000, quantity_denom: 10000,
        });
        expect(f).toEqual({ num: 150n, denom: 1n });
    });

    it('defaults quantity to value (price 1) when quantity omitted', () => {
        const f = impliedPriceFraction({
            account_guid: STOCK_GUID,
            value_num: 100, value_denom: 100,
        });
        expect(f).toEqual({ num: 1n, denom: 1n });
    });
});

describe('recordImpliedPrices', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.accountsFindMany.mockResolvedValue([
            { guid: STOCK_GUID, commodity_guid: COMMODITY_GUID },
        ]);
        mocks.pricesFindFirst.mockResolvedValue(null);
        mocks.pricesCreate.mockResolvedValue({});
    });

    const buySplits = [
        { account_guid: STOCK_GUID, value_num: 150000, value_denom: 100, quantity_num: 100000, quantity_denom: 10000 },
        { account_guid: CASH_GUID, value_num: -150000, value_denom: 100 },
    ];

    it('records a price for an investment buy', async () => {
        const created = await recordImpliedPrices({
            currency_guid: USD_GUID,
            post_date: new Date('2026-06-12T12:00:00Z'),
            splits: buySplits,
        });
        expect(created).toBe(1);
        expect(mocks.pricesCreate).toHaveBeenCalledTimes(1);
        const data = mocks.pricesCreate.mock.calls[0][0].data;
        expect(data.commodity_guid).toBe(COMMODITY_GUID);
        expect(data.currency_guid).toBe(USD_GUID);
        expect(data.value_num).toBe(150n);
        expect(data.value_denom).toBe(1n);
        expect(data.source).toBe('user:split-register');
        expect(data.type).toBe('transaction');
    });

    it('skips when a price already exists for that commodity/currency/date', async () => {
        mocks.pricesFindFirst.mockResolvedValue({ guid: 'x'.repeat(32) });
        const created = await recordImpliedPrices({
            currency_guid: USD_GUID,
            post_date: new Date('2026-06-12T12:00:00Z'),
            splits: buySplits,
        });
        expect(created).toBe(0);
        expect(mocks.pricesCreate).not.toHaveBeenCalled();
    });

    it('records nothing for zero-value transfers (the VOO bug)', async () => {
        const created = await recordImpliedPrices({
            currency_guid: USD_GUID,
            post_date: new Date('2023-07-05T15:59:00Z'),
            splits: [
                { account_guid: STOCK_GUID, value_num: 0, value_denom: 100, quantity_num: -5331102, quantity_denom: 10000 },
                { account_guid: CASH_GUID, value_num: 0, value_denom: 100 },
            ],
        });
        expect(created).toBe(0);
        expect(mocks.pricesCreate).not.toHaveBeenCalled();
    });

    it('records nothing when no split is on an investment account', async () => {
        mocks.accountsFindMany.mockResolvedValue([]);
        const created = await recordImpliedPrices({
            currency_guid: USD_GUID,
            post_date: new Date(),
            splits: [{ account_guid: CASH_GUID, value_num: 100, value_denom: 100 }],
        });
        expect(created).toBe(0);
        expect(mocks.pricesCreate).not.toHaveBeenCalled();
    });

    it('never throws on database errors (best-effort)', async () => {
        mocks.accountsFindMany.mockRejectedValue(new Error('db down'));
        const created = await recordImpliedPrices({
            currency_guid: USD_GUID,
            post_date: new Date(),
            splits: buySplits,
        });
        expect(created).toBe(0);
    });
});
