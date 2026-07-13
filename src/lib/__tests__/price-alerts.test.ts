import { describe, it, expect, vi, beforeEach } from 'vitest';

const { db, createNotificationMock } = vi.hoisted(() => ({
    db: {
        $queryRaw: vi.fn(),
        $executeRaw: vi.fn(),
        $executeRawUnsafe: vi.fn(),
        commodities: { findMany: vi.fn() },
    },
    createNotificationMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: db }));
vi.mock('@/lib/notifications', () => ({ createNotification: createNotificationMock }));

import {
    evaluateAlert,
    validatePriceAlertInput,
    checkPriceAlerts,
    PriceAlertValidationError,
    RETRIGGER_WINDOW_MS,
    type EvaluableAlert,
} from '../price-alerts';

const NOW = new Date('2026-07-12T12:00:00Z');

function alert(overrides: Partial<EvaluableAlert> = {}): EvaluableAlert {
    return {
        direction: 'above',
        threshold: 100,
        enabled: true,
        lastTriggeredAt: null,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    db.$executeRawUnsafe.mockResolvedValue(0);
    db.$executeRaw.mockResolvedValue(1);
    createNotificationMock.mockResolvedValue({ id: 1 });
});

// ---------------------------------------------------------------------------
// evaluateAlert — thresholds and directions
// ---------------------------------------------------------------------------

describe('evaluateAlert', () => {
    it("fires 'above' alerts when price meets or exceeds the threshold", () => {
        expect(evaluateAlert(alert(), 100.01, NOW)).toBe(true);
        expect(evaluateAlert(alert(), 100, NOW)).toBe(true); // touching counts
        expect(evaluateAlert(alert(), 99.99, NOW)).toBe(false);
    });

    it("fires 'below' alerts when price meets or drops under the threshold", () => {
        const a = alert({ direction: 'below', threshold: 50 });
        expect(evaluateAlert(a, 49.5, NOW)).toBe(true);
        expect(evaluateAlert(a, 50, NOW)).toBe(true);
        expect(evaluateAlert(a, 50.01, NOW)).toBe(false);
    });

    it('never fires disabled alerts', () => {
        expect(evaluateAlert(alert({ enabled: false }), 200, NOW)).toBe(false);
    });

    it('ignores non-finite prices and thresholds', () => {
        expect(evaluateAlert(alert(), NaN, NOW)).toBe(false);
        expect(evaluateAlert(alert(), Infinity, NOW)).toBe(false);
        expect(evaluateAlert(alert({ threshold: NaN }), 100, NOW)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// evaluateAlert — 24h retrigger suppression
// ---------------------------------------------------------------------------

describe('evaluateAlert retrigger suppression', () => {
    it('suppresses alerts that fired within the last 24 hours', () => {
        const oneHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000);
        expect(evaluateAlert(alert({ lastTriggeredAt: oneHourAgo }), 150, NOW)).toBe(false);

        const almost24h = new Date(NOW.getTime() - RETRIGGER_WINDOW_MS + 1000);
        expect(evaluateAlert(alert({ lastTriggeredAt: almost24h }), 150, NOW)).toBe(false);
    });

    it('re-fires once the 24-hour window has elapsed', () => {
        const exactly24h = new Date(NOW.getTime() - RETRIGGER_WINDOW_MS);
        expect(evaluateAlert(alert({ lastTriggeredAt: exactly24h }), 150, NOW)).toBe(true);

        const twoDaysAgo = new Date(NOW.getTime() - 2 * RETRIGGER_WINDOW_MS);
        expect(evaluateAlert(alert({ lastTriggeredAt: twoDaysAgo }), 150, NOW)).toBe(true);
    });

    it('a never-triggered alert is not suppressed', () => {
        expect(evaluateAlert(alert({ lastTriggeredAt: null }), 150, NOW)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('validatePriceAlertInput', () => {
    const guid = 'c'.repeat(32);

    it('accepts a valid payload and coerces the threshold to a number', () => {
        const v = validatePriceAlertInput({ commodityGuid: guid, direction: 'below', threshold: 42.5 });
        expect(v).toEqual({ commodityGuid: guid, direction: 'below', threshold: 42.5 });
    });

    it('rejects bad GUIDs, directions, and thresholds', () => {
        expect(() => validatePriceAlertInput({ commodityGuid: 'short', direction: 'above', threshold: 1 }))
            .toThrow(PriceAlertValidationError);
        expect(() => validatePriceAlertInput({
            commodityGuid: guid,
            direction: 'sideways' as unknown as 'above',
            threshold: 1,
        })).toThrow(PriceAlertValidationError);
        expect(() => validatePriceAlertInput({ commodityGuid: guid, direction: 'above', threshold: 0 }))
            .toThrow(PriceAlertValidationError);
        expect(() => validatePriceAlertInput({ commodityGuid: guid, direction: 'above', threshold: NaN }))
            .toThrow(PriceAlertValidationError);
    });
});

// ---------------------------------------------------------------------------
// checkPriceAlerts — end-to-end with mocked prisma
// ---------------------------------------------------------------------------

const COMMODITY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOOK = 'book1234book1234book1234book1234';

function alertRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 11,
        user_id: 7,
        book_guid: BOOK,
        commodity_guid: COMMODITY,
        direction: 'above',
        threshold: 100,
        enabled: true,
        last_triggered_at: null,
        created_at: new Date('2026-07-01T00:00:00Z'),
        ...overrides,
    };
}

function priceRow(num: bigint, denom: bigint, date = new Date('2026-07-11T00:00:00Z')) {
    return { commodity_guid: COMMODITY, value_num: num, value_denom: denom, date };
}

describe('checkPriceAlerts', () => {
    it('does nothing when there are no enabled alerts', async () => {
        db.$queryRaw.mockResolvedValueOnce([]);
        const result = await checkPriceAlerts(NOW);
        expect(result).toEqual({ checked: 0, triggered: 0 });
        expect(createNotificationMock).not.toHaveBeenCalled();
    });

    it('notifies and stamps last_triggered_at when a threshold is crossed', async () => {
        db.$queryRaw
            .mockResolvedValueOnce([alertRow()])                    // alerts
            .mockResolvedValueOnce([priceRow(10550n, 100n)]);       // latest prices (105.50)
        db.commodities.findMany.mockResolvedValueOnce([
            { guid: COMMODITY, mnemonic: 'AAPL', fullname: 'Apple Inc' },
        ]);

        const result = await checkPriceAlerts(NOW);
        expect(result).toEqual({ checked: 1, triggered: 1 });

        expect(createNotificationMock).toHaveBeenCalledTimes(1);
        const input = createNotificationMock.mock.calls[0][0];
        expect(input.userId).toBe(7);
        expect(input.bookGuid).toBe(BOOK);
        expect(input.type).toBe('price_alert');
        expect(input.severity).toBe('info');
        expect(input.title).toContain('AAPL');
        expect(input.title).toContain('above');
        expect(input.href).toBe(`/reports/price_history?commodityGuid=${COMMODITY}`);

        // last_triggered_at stamped
        expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('does not notify when the price has not crossed the threshold', async () => {
        db.$queryRaw
            .mockResolvedValueOnce([alertRow()])
            .mockResolvedValueOnce([priceRow(9950n, 100n)]);        // 99.50 < 100
        db.commodities.findMany.mockResolvedValueOnce([
            { guid: COMMODITY, mnemonic: 'AAPL', fullname: null },
        ]);

        const result = await checkPriceAlerts(NOW);
        expect(result).toEqual({ checked: 1, triggered: 0 });
        expect(createNotificationMock).not.toHaveBeenCalled();
        expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it('suppresses alerts re-triggered within 24 hours', async () => {
        const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
        db.$queryRaw
            .mockResolvedValueOnce([alertRow({ last_triggered_at: twoHoursAgo })])
            .mockResolvedValueOnce([priceRow(20000n, 100n)]);       // 200 >> 100
        db.commodities.findMany.mockResolvedValueOnce([
            { guid: COMMODITY, mnemonic: 'AAPL', fullname: null },
        ]);

        const result = await checkPriceAlerts(NOW);
        expect(result).toEqual({ checked: 1, triggered: 0 });
        expect(createNotificationMock).not.toHaveBeenCalled();
    });

    it('skips alerts for commodities that have no stored prices', async () => {
        db.$queryRaw
            .mockResolvedValueOnce([alertRow()])
            .mockResolvedValueOnce([]);                             // no prices
        db.commodities.findMany.mockResolvedValueOnce([]);

        const result = await checkPriceAlerts(NOW);
        expect(result).toEqual({ checked: 1, triggered: 0 });
        expect(createNotificationMock).not.toHaveBeenCalled();
    });

    it('keeps checking remaining alerts when one notification fails', async () => {
        const secondCommodity = 'b'.repeat(32);
        db.$queryRaw
            .mockResolvedValueOnce([
                alertRow(),
                alertRow({ id: 12, commodity_guid: secondCommodity, direction: 'below', threshold: 300 }),
            ])
            .mockResolvedValueOnce([
                priceRow(15000n, 100n),                              // 150 (above 100 → fires)
                { commodity_guid: secondCommodity, value_num: 25000n, value_denom: 100n, date: new Date('2026-07-11T00:00:00Z') }, // 250 (below 300 → fires)
            ]);
        db.commodities.findMany.mockResolvedValueOnce([
            { guid: COMMODITY, mnemonic: 'AAPL', fullname: null },
            { guid: secondCommodity, mnemonic: 'MSFT', fullname: null },
        ]);
        createNotificationMock
            .mockRejectedValueOnce(new Error('smtp down'))
            .mockResolvedValueOnce({ id: 2 });

        const result = await checkPriceAlerts(NOW);
        expect(result).toEqual({ checked: 2, triggered: 1 });
        expect(createNotificationMock).toHaveBeenCalledTimes(2);
        // Only the successful alert was stamped
        expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    });
});
