import { describe, it, expect, vi, beforeEach } from 'vitest';

const { db } = vi.hoisted(() => ({
    db: {
        accounts: { findMany: vi.fn() },
        splits: { findMany: vi.fn() },
        prices: { findMany: vi.fn() },
    },
}));

vi.mock('@/lib/prisma', () => ({ default: db }));

import {
    endOfDay,
    sumQuantitiesAsOf,
    pickLatestPricesAsOf,
    summarizeAsOf,
    compareAsOf,
    bookAsOf,
    type BookAsOf,
} from '../time-machine';

// ---------------------------------------------------------------------------
// Fixtures: a small book with a bank account, a brokerage, and a mortgage.
// Split history spans 2020-2026 so mid-history dates are meaningful.
// ---------------------------------------------------------------------------

const ACCOUNTS = [
    {
        guid: 'assets',
        name: 'Assets',
        account_type: 'ASSET',
        parent_guid: 'root',
        commodity_guid: 'usd',
        commodity: { namespace: 'CURRENCY' },
    },
    {
        guid: 'bank',
        name: 'Checking',
        account_type: 'BANK',
        parent_guid: 'assets',
        commodity_guid: 'usd',
        commodity: { namespace: 'CURRENCY' },
    },
    {
        guid: 'stock',
        name: 'VTI',
        account_type: 'STOCK',
        parent_guid: 'assets',
        commodity_guid: 'vti',
        commodity: { namespace: 'NASDAQ' },
    },
    {
        guid: 'mortgage',
        name: 'Mortgage',
        account_type: 'LIABILITY',
        parent_guid: 'root',
        commodity_guid: 'usd',
        commodity: { namespace: 'CURRENCY' },
    },
];

function split(accountGuid: string, date: string, num: number, denom = 100) {
    return {
        account_guid: accountGuid,
        quantity_num: BigInt(num),
        quantity_denom: BigInt(denom),
        transaction: { post_date: new Date(`${date}T12:00:00Z`) },
    };
}

const SPLITS = [
    split('bank', '2020-01-15', 100000),        // +1000.00
    split('bank', '2022-06-01', 50000),         // +500.00
    split('bank', '2025-03-01', 25000),         // +250.00
    split('stock', '2021-05-10', 100000, 10000), // +10 shares
    split('stock', '2024-02-01', 50000, 10000),  // +5 shares
    split('mortgage', '2020-01-15', -20000000), // -200,000.00
    split('mortgage', '2023-01-15', 5000000),   // +50,000.00 paydown
];

function price(date: string, value: number) {
    return {
        commodity_guid: 'vti',
        date: new Date(`${date}T00:00:00Z`),
        value_num: BigInt(Math.round(value * 100)),
        value_denom: BigInt(100),
    };
}

const PRICES = [
    price('2021-06-01', 100),
    price('2022-06-01', 120),
    price('2024-06-01', 200),
    { ...price('2023-01-01', 0), value_num: BigInt(0) }, // implied $0 — skipped
];

beforeEach(() => {
    vi.clearAllMocks();
    db.accounts.findMany.mockResolvedValue(ACCOUNTS);
    db.splits.findMany.mockResolvedValue(SPLITS);
    db.prices.findMany.mockResolvedValue(PRICES);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('endOfDay', () => {
    it('is the last instant of the UTC day', () => {
        const d = endOfDay('2022-12-31');
        expect(d.toISOString()).toBe('2022-12-31T23:59:59.999Z');
    });
});

describe('sumQuantitiesAsOf', () => {
    it('sums only splits posted on or before the cutoff (mid-history)', () => {
        const sums = sumQuantitiesAsOf(SPLITS, endOfDay('2022-12-31'));
        expect(sums.get('bank')).toBeCloseTo(1500, 6);       // 1000 + 500, not the 2025 deposit
        expect(sums.get('stock')).toBeCloseTo(10, 6);        // the 2024 lot not yet bought
        expect(sums.get('mortgage')).toBeCloseTo(-200000, 6); // paydown is in 2023
    });

    it('includes everything at the end of history', () => {
        const sums = sumQuantitiesAsOf(SPLITS, endOfDay('2026-12-31'));
        expect(sums.get('bank')).toBeCloseTo(1750, 6);
        expect(sums.get('stock')).toBeCloseTo(15, 6);
        expect(sums.get('mortgage')).toBeCloseTo(-150000, 6);
    });

    it('ignores splits without a post date', () => {
        const sums = sumQuantitiesAsOf(
            [{ ...split('bank', '2020-01-01', 100), transaction: { post_date: null } }],
            endOfDay('2026-01-01'),
        );
        expect(sums.get('bank')).toBeUndefined();
    });
});

describe('pickLatestPricesAsOf', () => {
    it('picks the latest price on or before the date', () => {
        expect(pickLatestPricesAsOf(PRICES, endOfDay('2022-12-31')).get('vti')).toBe(120);
        expect(pickLatestPricesAsOf(PRICES, endOfDay('2021-12-31')).get('vti')).toBe(100);
        expect(pickLatestPricesAsOf(PRICES, endOfDay('2026-01-01')).get('vti')).toBe(200);
    });

    it('returns nothing before the first price', () => {
        expect(pickLatestPricesAsOf(PRICES, endOfDay('2020-06-01')).has('vti')).toBe(false);
    });

    it('skips implied $0 prices', () => {
        // 2023-01-01 has a $0 price; the latest VALID price ≤ mid-2023 is 120.
        expect(pickLatestPricesAsOf(PRICES, endOfDay('2023-06-01')).get('vti')).toBe(120);
    });

    it('is order-independent', () => {
        const shuffled = [...PRICES].reverse();
        expect(pickLatestPricesAsOf(shuffled, endOfDay('2026-01-01')).get('vti')).toBe(200);
    });
});

describe('summarizeAsOf', () => {
    it('computes net worth as assets + liabilities, excluding equity', () => {
        const summary = summarizeAsOf([
            { type: 'BANK', balance: 1500 },
            { type: 'STOCK', balance: 1200 },
            { type: 'LIABILITY', balance: -200000 },
            { type: 'EQUITY', balance: -999 },
            { type: 'INCOME', balance: -50 },
        ]);
        expect(summary.assets).toBeCloseTo(2700, 6);
        expect(summary.liabilities).toBeCloseTo(-200000, 6);
        expect(summary.netWorth).toBeCloseTo(-197300, 6);
        expect(summary.byType.BANK).toBeCloseTo(1500, 6);
        expect(summary.byType.EQUITY).toBeCloseTo(-999, 6);
    });
});

// ---------------------------------------------------------------------------
// bookAsOf (mocked prisma) — as-of balance math + price-as-of selection
// ---------------------------------------------------------------------------

describe('bookAsOf', () => {
    it('values the book at a mid-history date', async () => {
        const result = await bookAsOf(['assets', 'bank', 'stock', 'mortgage'], '2022-12-31');

        const byGuid = new Map(result.accounts.map(a => [a.guid, a]));
        expect(byGuid.get('bank')!.balance).toBeCloseTo(1500, 2);
        // 10 shares × $120 (price as of 2022-06-01)
        expect(byGuid.get('stock')!.quantity).toBeCloseTo(10, 6);
        expect(byGuid.get('stock')!.balance).toBeCloseTo(1200, 2);
        expect(byGuid.get('mortgage')!.balance).toBeCloseTo(-200000, 2);

        expect(result.summary.assets).toBeCloseTo(2700, 2);
        expect(result.summary.liabilities).toBeCloseTo(-200000, 2);
        expect(result.summary.netWorth).toBeCloseTo(-197300, 2);
    });

    it('rolls descendants up into parent totals', async () => {
        const result = await bookAsOf(['assets', 'bank', 'stock', 'mortgage'], '2022-12-31');
        const assets = result.tree.find(n => n.guid === 'assets')!;
        expect(assets.balance).toBeCloseTo(0, 6);
        expect(assets.total).toBeCloseTo(2700, 2); // bank 1500 + stock 1200
        expect(assets.children.map(c => c.guid).sort()).toEqual(['bank', 'stock']);
        // mortgage's parent (root) is outside the set → it is a top-level node
        expect(result.tree.some(n => n.guid === 'mortgage')).toBe(true);
    });

    it('uses the later price and splits at a later date', async () => {
        const result = await bookAsOf(['assets', 'bank', 'stock', 'mortgage'], '2026-07-01');
        const byGuid = new Map(result.accounts.map(a => [a.guid, a]));
        expect(byGuid.get('bank')!.balance).toBeCloseTo(1750, 2);
        expect(byGuid.get('stock')!.balance).toBeCloseTo(15 * 200, 2);
        expect(byGuid.get('mortgage')!.balance).toBeCloseTo(-150000, 2);
    });

    it('values securities at 0 when no price exists on or before the date', async () => {
        const result = await bookAsOf(['assets', 'bank', 'stock', 'mortgage'], '2021-05-31');
        const stock = result.accounts.find(a => a.guid === 'stock')!;
        expect(stock.quantity).toBeCloseTo(10, 6); // bought 2021-05-10
        expect(stock.balance).toBe(0);             // first price is 2021-06-01
    });
});

// ---------------------------------------------------------------------------
// compareAsOf
// ---------------------------------------------------------------------------

describe('compareAsOf', () => {
    it('computes per-account and summary deltas between two dates', async () => {
        const before: BookAsOf = await bookAsOf(['assets', 'bank', 'stock', 'mortgage'], '2022-12-31');
        const after: BookAsOf = await bookAsOf(['assets', 'bank', 'stock', 'mortgage'], '2026-07-01');

        const diff = compareAsOf(before, after);
        expect(diff.fromDate).toBe('2022-12-31');
        expect(diff.toDate).toBe('2026-07-01');

        expect(diff.byGuid.bank.delta).toBeCloseTo(250, 2);                  // 1750 - 1500
        expect(diff.byGuid.stock.delta).toBeCloseTo(3000 - 1200, 2);         // 15×200 - 10×120
        expect(diff.byGuid.mortgage.delta).toBeCloseTo(50000, 2);            // paydown
        expect(diff.summary.assets).toBeCloseTo(250 + 1800, 2);
        expect(diff.summary.liabilities).toBeCloseTo(50000, 2);
        expect(diff.summary.netWorth).toBeCloseTo(250 + 1800 + 50000, 2);
    });

    it('treats accounts missing on one side as zero', () => {
        const mk = (accounts: Array<{ guid: string; balance: number }>): BookAsOf => ({
            asOf: '2026-01-01',
            tree: [],
            accounts: accounts.map(a => ({
                guid: a.guid,
                name: a.guid,
                path: a.guid,
                type: 'BANK',
                quantity: a.balance,
                balance: a.balance,
                total: a.balance,
            })),
            summary: { netWorth: 0, assets: 0, liabilities: 0, byType: {} },
        });

        const diff = compareAsOf(
            mk([{ guid: 'old', balance: 100 }]),
            mk([{ guid: 'new', balance: 40 }]),
        );
        expect(diff.byGuid.old.delta).toBeCloseTo(-100, 6);
        expect(diff.byGuid.new.delta).toBeCloseTo(40, 6);
    });
});
