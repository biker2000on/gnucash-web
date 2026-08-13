/**
 * Investment Lots report — lot arithmetic must come from the canonical lot
 * engine (src/lib/lots.ts), not be re-derived in the route.
 *
 * These tests mock the DATABASE, not the engine, so the same fixture book
 * exercises whatever arithmetic the route actually performs. The transferred-lot
 * cases below fail against a route that re-derives basis and holding period
 * from raw splits: such a route sees only the $0-value in-kind transfer-in
 * split (basis ~$0) and only the transfer post date (short-term).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const ACCOUNT = 'a'.repeat(32);
const COMMODITY = 'c'.repeat(32);
const USD = 'u'.repeat(32);
const TRANSFER_LOT = 't'.repeat(32);
const PURCHASE_LOT = 'p'.repeat(32);

/** Original purchase date carried through the in-kind transfer. */
const ACQUIRED = '2015-03-10T12:00:00.000Z';
/** Date the receiving account actually got the shares — under one year old. */
const TRANSFERRED_IN = '2026-05-01T12:00:00.000Z';
const PURCHASED = '2020-01-15T12:00:00.000Z';

const CARRIED_BASIS = 5000;
const PRICE_PER_SHARE = 12;

const mocks = vi.hoisted(() => ({
    requireRole: vi.fn(),
    getBookAccountGuids: vi.fn(),
    buildAccountPathMap: vi.fn(),
    getBaseCurrency: vi.fn(),
    getLatestPrice: vi.fn(),
    accountsFindMany: vi.fn(),
    lotsFindMany: vi.fn(),
    slotsFindMany: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole: mocks.requireRole }));
vi.mock('@/lib/book-scope', () => ({ getBookAccountGuids: mocks.getBookAccountGuids }));
vi.mock('@/lib/reports/utils', () => ({ buildAccountPathMap: mocks.buildAccountPathMap }));
vi.mock('@/lib/currency', () => ({ getBaseCurrency: mocks.getBaseCurrency }));
vi.mock('@/lib/commodities', () => ({ getLatestPrice: mocks.getLatestPrice }));
vi.mock('@/lib/prisma', async () => {
    const gnucash = await vi.importActual<typeof import('@/lib/gnucash')>('@/lib/gnucash');
    return {
        default: {
            accounts: { findMany: mocks.accountsFindMany },
            lots: { findMany: mocks.lotsFindMany },
            slots: { findMany: mocks.slotsFindMany },
        },
        toDecimal: gnucash.toDecimal,
        fromDecimal: gnucash.fromDecimal,
        generateGuid: gnucash.generateGuid,
    };
});

import { GET } from '../route';

function split(overrides: {
    guid: string;
    quantity: bigint;
    valueCents: bigint;
    postDate: string;
    description: string;
    lotGuid: string;
}) {
    return {
        guid: overrides.guid,
        tx_guid: `tx-${overrides.guid}`,
        lot_guid: overrides.lotGuid,
        account_guid: ACCOUNT,
        quantity_num: overrides.quantity,
        quantity_denom: 1n,
        value_num: overrides.valueCents,
        value_denom: 100n,
        transaction: {
            post_date: new Date(overrides.postDate),
            description: overrides.description,
        },
    };
}

/**
 * A transferred-in lot: 100 shares arrive with $0 of their own value, and the
 * $5,000 basis they were bought for lives in the `carried_basis` slot. Bought
 * in 2015, transferred in 2026.
 */
const transferSplit = split({
    guid: 'split-transfer',
    quantity: 100n,
    valueCents: 0n,
    postDate: TRANSFERRED_IN,
    description: 'Transfer in from brokerage',
    lotGuid: TRANSFER_LOT,
});

/** An ordinary purchase: 50 shares for $1,000 in 2020. Regression control. */
const purchaseSplit = split({
    guid: 'split-purchase',
    quantity: 50n,
    valueCents: 100_000n,
    postDate: PURCHASED,
    description: 'Buy VTSAX',
    lotGuid: PURCHASE_LOT,
});

const LOTS = [
    { guid: TRANSFER_LOT, account_guid: ACCOUNT, is_closed: 0, splits: [transferSplit] },
    { guid: PURCHASE_LOT, account_guid: ACCOUNT, is_closed: 0, splits: [purchaseSplit] },
];

const SLOTS = [
    { obj_guid: TRANSFER_LOT, name: 'title', string_val: 'Transferred Lot' },
    { obj_guid: TRANSFER_LOT, name: 'acquisition_date', string_val: ACQUIRED },
    { obj_guid: TRANSFER_LOT, name: 'carried_basis', string_val: String(CARRIED_BASIS) },
    { obj_guid: PURCHASE_LOT, name: 'title', string_val: 'Purchase Lot' },
];

function request(query = 'endDate=2026-12-31') {
    return { url: `http://localhost/api/reports/investment-lots?${query}` } as NextRequest;
}

interface Row {
    lotGuid: string;
    openDate: string | null;
    acquisitionDate: string | null;
    shares: number;
    costBasis: number;
    marketValue: number | null;
    realizedGain: number;
    unrealizedGain: number | null;
    totalGain: number | null;
    holdingPeriod: 'short_term' | 'long_term' | null;
    daysHeld: number | null;
}

async function fetchRows(query?: string): Promise<Map<string, Row>> {
    const response = await GET(request(query));
    expect(response.status).toBe(200);
    const body = await response.json();
    return new Map<string, Row>(body.rows.map((r: Row) => [r.lotGuid, r]));
}

describe('investment lots report', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireRole.mockResolvedValue({ user: { id: 1 }, bookGuid: 'book', role: 'readonly' });
        mocks.getBookAccountGuids.mockResolvedValue([ACCOUNT]);
        mocks.buildAccountPathMap.mockResolvedValue(new Map([[ACCOUNT, 'Assets:Investments:VTSAX']]));
        mocks.getBaseCurrency.mockResolvedValue({ guid: USD, mnemonic: 'USD', fullname: 'US Dollar', fraction: 100 });
        mocks.getLatestPrice.mockResolvedValue({
            guid: 'price', date: new Date('2026-08-01T00:00:00.000Z'), value: PRICE_PER_SHARE, source: 'test',
        });
        mocks.accountsFindMany.mockResolvedValue([{
            guid: ACCOUNT,
            name: 'VTSAX',
            account_type: 'MUTUAL',
            commodity_guid: COMMODITY,
            commodity: { guid: COMMODITY, mnemonic: 'VTSAX', namespace: 'FUND' },
            lots: LOTS,
        }]);
        mocks.lotsFindMany.mockResolvedValue(LOTS);
        mocks.slotsFindMany.mockImplementation(async (args: {
            where: { obj_guid: { in: string[] }; name: string | { in: string[] } };
        }) => {
            const guids = new Set(args.where.obj_guid.in);
            const name = args.where.name;
            const names = typeof name === 'string' ? new Set([name]) : new Set(name.in);
            return SLOTS.filter(s => guids.has(s.obj_guid) && names.has(s.name));
        });
    });

    it('reports the CARRIED basis for a transferred-in lot, not the $0 transfer value', async () => {
        const rows = await fetchRows();
        const lot = rows.get(TRANSFER_LOT);

        expect(lot).toBeDefined();
        expect(lot!.shares).toBe(100);
        // The in-kind transfer-in split carries $0 of its own value; the real
        // basis lives in the carried_basis slot and the engine applies it.
        expect(lot!.costBasis).toBeCloseTo(CARRIED_BASIS, 6);
        expect(lot!.marketValue).toBeCloseTo(100 * PRICE_PER_SHARE, 6);
        // 100 * $12 = $1,200 market value against $5,000 basis: a real LOSS.
        // Ignoring carried basis reports this as a +$1,200 gain.
        expect(lot!.unrealizedGain).toBeCloseTo(1200 - CARRIED_BASIS, 6);
        expect(lot!.unrealizedGain!).toBeLessThan(0);
        expect(lot!.totalGain).toBeCloseTo(1200 - CARRIED_BASIS, 6);
        expect(lot!.realizedGain).toBe(0);
    });

    it('classifies a transferred-in lot by its ORIGINAL acquisition date, not the transfer date', async () => {
        const rows = await fetchRows();
        const lot = rows.get(TRANSFER_LOT);

        expect(lot).toBeDefined();
        // Shares landed in this account on 2026-05-01 — under a year ago — but
        // were acquired 2015-03-10, so the sale would be long-term.
        expect(lot!.openDate).toBe('2026-05-01');
        expect(lot!.acquisitionDate).toBe('2015-03-10');
        expect(lot!.holdingPeriod).toBe('long_term');
        // Days held must run from acquisition (>10 years), not the transfer.
        expect(lot!.daysHeld).toBeGreaterThan(4000);
    });

    it('leaves an ordinary purchased lot unchanged', async () => {
        const rows = await fetchRows();
        const lot = rows.get(PURCHASE_LOT);

        expect(lot).toBeDefined();
        expect(lot!.openDate).toBe('2020-01-15');
        expect(lot!.acquisitionDate).toBeNull();
        expect(lot!.shares).toBe(50);
        expect(lot!.costBasis).toBeCloseTo(1000, 6);
        expect(lot!.marketValue).toBeCloseTo(50 * PRICE_PER_SHARE, 6);
        expect(lot!.unrealizedGain).toBeCloseTo(600 - 1000, 6);
        expect(lot!.realizedGain).toBe(0);
        expect(lot!.totalGain).toBeCloseTo(-400, 6);
        expect(lot!.holdingPeriod).toBe('long_term');
        expect(lot!.daysHeld).toBeGreaterThan(2000);
    });

    it('prices holdings with the base-currency quote', async () => {
        await fetchRows();
        expect(mocks.getLatestPrice).toHaveBeenCalledWith(COMMODITY, USD);
    });

    it('summarises basis and unrealized gain over the engine figures', async () => {
        const response = await GET(request());
        const body = await response.json();

        expect(body.summary.openLotCount).toBe(2);
        expect(body.summary.closedLotCount).toBe(0);
        expect(body.summary.longTermCount).toBe(2);
        expect(body.summary.shortTermCount).toBe(0);
        expect(body.summary.totalCostBasis).toBeCloseTo(CARRIED_BASIS + 1000, 6);
        expect(body.summary.totalMarketValue).toBeCloseTo(1200 + 600, 6);
        expect(body.summary.totalUnrealizedGain).toBeCloseTo(-3800 + -400, 6);
        expect(body.summary.totalRealizedGain).toBe(0);
    });

    it('excludes lots opened after the end date', async () => {
        const rows = await fetchRows('endDate=2021-01-01');
        expect(rows.has(PURCHASE_LOT)).toBe(true);
        expect(rows.has(TRANSFER_LOT)).toBe(false);
    });
});
