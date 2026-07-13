import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAccountsFindMany = vi.fn();
const mockPricesFindMany = vi.fn();
const mockQueryRaw = vi.fn();
const mockGetBaseCurrency = vi.fn();

vi.mock('../prisma', () => ({
    default: {
        accounts: {
            findMany: (...args: unknown[]) => mockAccountsFindMany(...args),
        },
        prices: {
            findMany: (...args: unknown[]) => mockPricesFindMany(...args),
        },
        $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    },
}));

vi.mock('../currency', () => ({
    getBaseCurrency: (...args: unknown[]) => mockGetBaseCurrency(...args),
}));

import {
    computeFxPositions,
    generateFxRevaluation,
    type FxFlowRow,
} from '../reports/fx-revaluation';

const PERIOD = { start: '2026-01-01', end: '2026-12-31' };

function positionsOf(rows: FxFlowRow[], rates: Parameters<typeof computeFxPositions>[1] = {}) {
    return computeFxPositions(rows, rates, PERIOD.start, PERIOD.end).positions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Average acquisition rate math
// ─────────────────────────────────────────────────────────────────────────────

describe('computeFxPositions — average rate', () => {
    it('computes a weighted average across multiple acquisitions', () => {
        // 100 EUR @ 1.10 + 100 EUR @ 1.20 → avg 1.15
        const rows: FxFlowRow[] = [
            { currency: 'EUR', postDate: '2026-01-05', quantity: 100, baseValue: 110 },
            { currency: 'EUR', postDate: '2026-02-05', quantity: 100, baseValue: 120 },
        ];
        const [position] = positionsOf(rows);
        expect(position.quantity).toBeCloseTo(200, 9);
        expect(position.avgRate).toBeCloseTo(1.15, 9);
        expect(position.baseCost).toBeCloseTo(230, 9);
    });

    it('leaves the average rate unchanged by a disposal (moving-average method)', () => {
        const rows: FxFlowRow[] = [
            { currency: 'EUR', postDate: '2026-01-05', quantity: 100, baseValue: 110 },
            { currency: 'EUR', postDate: '2026-02-05', quantity: 100, baseValue: 120 },
            { currency: 'EUR', postDate: '2026-03-05', quantity: -50, baseValue: -60 },
        ];
        const [position] = positionsOf(rows);
        expect(position.quantity).toBeCloseTo(150, 9);
        expect(position.avgRate).toBeCloseTo(1.15, 9); // unchanged by sell
        expect(position.baseCost).toBeCloseTo(172.5, 9);
    });

    it('realizes gain = proceeds − qty × avg rate on disposal', () => {
        const rows: FxFlowRow[] = [
            { currency: 'EUR', postDate: '2026-01-05', quantity: 100, baseValue: 110 },
            // Sell 50 EUR for 60 USD → proceeds 60, cost 50 × 1.10 = 55, gain 5
            { currency: 'EUR', postDate: '2026-03-05', quantity: -50, baseValue: -60 },
        ];
        const { positions, realizedEvents } = computeFxPositions(rows, {}, PERIOD.start, PERIOD.end);
        expect(realizedEvents).toHaveLength(1);
        expect(realizedEvents[0].gainLoss).toBeCloseTo(5, 9);
        expect(positions[0].realizedGainLoss).toBeCloseTo(5, 9);
        expect(positions[0].realizedAllTime).toBeCloseTo(5, 9);
    });

    it('only counts realized events inside the requested period', () => {
        const rows: FxFlowRow[] = [
            { currency: 'EUR', postDate: '2025-01-05', quantity: 100, baseValue: 100 }, // avg 1.00
            { currency: 'EUR', postDate: '2025-06-01', quantity: -10, baseValue: -12 }, // +2, outside
            { currency: 'EUR', postDate: '2026-06-01', quantity: -10, baseValue: -13 }, // +3, inside
        ];
        const [position] = positionsOf(rows);
        expect(position.realizedGainLoss).toBeCloseTo(3, 9);
        expect(position.realizedAllTime).toBeCloseTo(5, 9);
    });

    it('sorts flows chronologically even if given out of order', () => {
        const rows: FxFlowRow[] = [
            // Sell arrives first in the array but happens after the buy
            { currency: 'EUR', postDate: '2026-03-05', quantity: -50, baseValue: -60 },
            { currency: 'EUR', postDate: '2026-01-05', quantity: 100, baseValue: 110 },
        ];
        const [position] = positionsOf(rows);
        expect(position.realizedAllTime).toBeCloseTo(5, 9);
        expect(position.quantity).toBeCloseTo(50, 9);
    });

    it('accumulates cross-currency flows into the other bucket at the prevailing avg', () => {
        const rows: FxFlowRow[] = [
            { currency: 'EUR', postDate: '2026-01-05', quantity: 100, baseValue: 110 },
            // EUR received in a EUR→GBP style transaction: no base value
            { currency: 'EUR', postDate: '2026-02-05', quantity: 50, baseValue: null },
        ];
        const [position] = positionsOf(rows);
        expect(position.quantity).toBeCloseTo(150, 9);
        expect(position.otherQuantity).toBeCloseTo(50, 9);
        expect(position.avgRate).toBeCloseTo(1.10, 9); // carried at avg, avg unchanged
    });

    it('ignores zero-quantity value-only splits', () => {
        const rows: FxFlowRow[] = [
            { currency: 'EUR', postDate: '2026-01-05', quantity: 100, baseValue: 110 },
            { currency: 'EUR', postDate: '2026-01-06', quantity: 0, baseValue: 25 },
        ];
        const [position] = positionsOf(rows);
        expect(position.avgRate).toBeCloseTo(1.10, 9);
        expect(position.baseCost).toBeCloseTo(110, 9);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unrealized computation
// ─────────────────────────────────────────────────────────────────────────────

describe('computeFxPositions — unrealized gain/loss', () => {
    it('computes qty × (current − avg)', () => {
        const rows: FxFlowRow[] = [
            { currency: 'EUR', postDate: '2026-01-05', quantity: 200, baseValue: 220 }, // avg 1.10
        ];
        const [position] = positionsOf(rows, { EUR: { rate: 1.25, date: '2026-07-01' } });
        expect(position.currentRate).toBeCloseTo(1.25, 9);
        expect(position.unrealizedGainLoss).toBeCloseTo(200 * (1.25 - 1.1), 9);
        expect(position.currentValue).toBeCloseTo(250, 9);
        expect(position.currentRateDate).toBe('2026-07-01');
    });

    it('reports null unrealized when there is no current rate', () => {
        const rows: FxFlowRow[] = [
            { currency: 'EUR', postDate: '2026-01-05', quantity: 200, baseValue: 220 },
        ];
        const [position] = positionsOf(rows, {});
        expect(position.currentRate).toBeNull();
        expect(position.unrealizedGainLoss).toBeNull();
        expect(position.currentValue).toBeNull();
    });

    it('reports null unrealized when the avg rate is unknown (all flows unvalued)', () => {
        const rows: FxFlowRow[] = [
            { currency: 'EUR', postDate: '2026-01-05', quantity: 100, baseValue: null },
        ];
        const [position] = positionsOf(rows, { EUR: { rate: 1.25, date: null } });
        expect(position.avgRate).toBeNull();
        expect(position.unrealizedGainLoss).toBeNull();
        expect(position.otherQuantity).toBeCloseTo(100, 9);
    });

    it('handles multiple currencies independently and sorts them', () => {
        const rows: FxFlowRow[] = [
            { currency: 'JPY', postDate: '2026-01-05', quantity: 10000, baseValue: 70 },
            { currency: 'EUR', postDate: '2026-01-05', quantity: 100, baseValue: 110 },
        ];
        const positions = positionsOf(rows, {
            EUR: { rate: 1.2, date: null },
            JPY: { rate: 0.0065, date: null },
        });
        expect(positions.map(p => p.currency)).toEqual(['EUR', 'JPY']);
        expect(positions[0].unrealizedGainLoss).toBeCloseTo(100 * (1.2 - 1.1), 9);
        expect(positions[1].unrealizedGainLoss).toBeCloseTo(10000 * (0.0065 - 0.007), 9);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Zero-foreign-currency case (generateFxRevaluation with mocked prisma)
// ─────────────────────────────────────────────────────────────────────────────

describe('generateFxRevaluation', () => {
    beforeEach(() => {
        mockAccountsFindMany.mockReset();
        mockPricesFindMany.mockReset();
        mockQueryRaw.mockReset();
        mockGetBaseCurrency.mockReset();
        mockGetBaseCurrency.mockResolvedValue({
            guid: 'usd-guid',
            mnemonic: 'USD',
            fullname: 'US Dollar',
            fraction: 100,
        });
    });

    it('returns a clean empty report when the book has no foreign-currency accounts', async () => {
        mockAccountsFindMany.mockResolvedValue([]);

        const report = await generateFxRevaluation({
            bookAccountGuids: ['a1', 'a2'],
            periodStart: PERIOD.start,
            periodEnd: PERIOD.end,
        });

        expect(report.hasForeignCurrency).toBe(false);
        expect(report.positions).toEqual([]);
        expect(report.baseCurrency).toBe('USD');
        expect(report.totals).toEqual({ unrealizedGainLoss: 0, realizedGainLoss: 0, currentValue: 0 });
        // No split/price queries should run
        expect(mockQueryRaw).not.toHaveBeenCalled();
        expect(mockPricesFindMany).not.toHaveBeenCalled();
    });

    it('returns a clean empty report for an empty account list', async () => {
        const report = await generateFxRevaluation({
            bookAccountGuids: [],
            periodStart: PERIOD.start,
            periodEnd: PERIOD.end,
        });
        expect(report.hasForeignCurrency).toBe(false);
        expect(mockAccountsFindMany).not.toHaveBeenCalled();
    });

    it('builds positions end-to-end with direct price lookup', async () => {
        mockAccountsFindMany.mockResolvedValue([
            { guid: 'acct-eur', commodity: { guid: 'eur-guid', mnemonic: 'EUR' } },
        ]);
        mockQueryRaw.mockResolvedValue([
            { account_guid: 'acct-eur', quantity: 100, base_value: 110, post_date: new Date('2026-01-05T00:00:00Z') },
            { account_guid: 'acct-eur', quantity: -20, base_value: -25, post_date: new Date('2026-03-05T00:00:00Z') },
        ]);
        mockPricesFindMany
            .mockResolvedValueOnce([
                { commodity_guid: 'eur-guid', date: new Date('2026-07-01T00:00:00Z'), value_num: 125n, value_denom: 100n },
            ])
            .mockResolvedValueOnce([]);

        const report = await generateFxRevaluation({
            bookAccountGuids: ['acct-eur'],
            periodStart: PERIOD.start,
            periodEnd: PERIOD.end,
        });

        expect(report.hasForeignCurrency).toBe(true);
        expect(report.positions).toHaveLength(1);
        const eur = report.positions[0];
        expect(eur.currency).toBe('EUR');
        expect(eur.quantity).toBeCloseTo(80, 9);
        expect(eur.avgRate).toBeCloseTo(1.10, 9);
        expect(eur.currentRate).toBeCloseTo(1.25, 9);
        expect(eur.unrealizedGainLoss).toBeCloseTo(80 * 0.15, 9);
        // Sell of 20 EUR for 25 USD: gain = 25 − 22 = 3
        expect(eur.realizedGainLoss).toBeCloseTo(3, 9);
        expect(report.totals.realizedGainLoss).toBeCloseTo(3, 9);
    });

    it('falls back to the inverse price when no direct rate exists', async () => {
        mockAccountsFindMany.mockResolvedValue([
            { guid: 'acct-eur', commodity: { guid: 'eur-guid', mnemonic: 'EUR' } },
        ]);
        mockQueryRaw.mockResolvedValue([
            { account_guid: 'acct-eur', quantity: 100, base_value: 110, post_date: new Date('2026-01-05T00:00:00Z') },
        ]);
        mockPricesFindMany
            .mockResolvedValueOnce([]) // no direct EUR→USD
            .mockResolvedValueOnce([
                // USD→EUR 0.80 → EUR→USD 1.25
                { currency_guid: 'eur-guid', date: new Date('2026-07-01T00:00:00Z'), value_num: 80n, value_denom: 100n },
            ]);

        const report = await generateFxRevaluation({
            bookAccountGuids: ['acct-eur'],
            periodStart: PERIOD.start,
            periodEnd: PERIOD.end,
        });

        expect(report.positions[0].currentRate).toBeCloseTo(1.25, 9);
    });
});
