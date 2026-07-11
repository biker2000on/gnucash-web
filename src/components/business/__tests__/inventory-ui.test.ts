import { describe, it, expect } from 'vitest';
import {
    MOVEMENT_TYPE_META,
    movementTypeMeta,
    movementQtyClass,
    formatQty,
    formatSignedQty,
    lowStockCount,
    totalStockValue,
    compareItems,
    computeBomDemand,
    computeBomOutput,
    demandShortfalls,
    defaultItemIdForEntry,
    parseQty,
    todayIso,
    type ItemDTO,
    type MovementDTO,
    type MovementType,
} from '@/components/business/inventory-ui';

const ALL_TYPES: MovementType[] = [
    'receive',
    'ship',
    'adjust',
    'transfer_in',
    'transfer_out',
    'assemble_consume',
    'assemble_produce',
    'return_in',
    'return_out',
];

function makeItem(overrides: Partial<ItemDTO> = {}): ItemDTO {
    return {
        id: 1,
        sku: 'SKU-1',
        name: 'Widget',
        description: null,
        unit: 'ea',
        salePrice: null,
        incomeAccountGuid: null,
        cogsAccountGuid: null,
        assetAccountGuid: null,
        avgCost: 0,
        valuationMethod: 'average',
        reorderPoint: null,
        reorderQuantity: null,
        active: true,
        onHand: 0,
        stockValue: 0,
        ...overrides,
    };
}

function makeMovement(overrides: Partial<MovementDTO> = {}): MovementDTO {
    return {
        id: 1,
        itemId: 1,
        locationId: 1,
        movementType: 'receive',
        quantity: 1,
        unitCost: null,
        movementDate: '2026-07-01',
        reference: null,
        invoiceGuid: null,
        entryGuid: null,
        txnGuid: null,
        counterpartMovementId: null,
        ...overrides,
    };
}

describe('movement type meta', () => {
    it('covers every movement type with a label and badge class', () => {
        for (const type of ALL_TYPES) {
            const meta = MOVEMENT_TYPE_META[type];
            expect(meta, `missing meta for ${type}`).toBeDefined();
            expect(meta.label.length).toBeGreaterThan(0);
            expect(meta.badgeClass).toMatch(/text-/);
        }
    });

    it('falls back gracefully for unknown types', () => {
        const meta = movementTypeMeta('bogus' as MovementType);
        expect(meta.label).toBe('bogus');
        expect(meta.badgeClass).toContain('text-foreground-muted');
    });

    it('colors inbound green and outbound red', () => {
        expect(MOVEMENT_TYPE_META.receive.badgeClass).toContain('text-positive');
        expect(MOVEMENT_TYPE_META.return_in.badgeClass).toContain('text-positive');
        expect(MOVEMENT_TYPE_META.ship.badgeClass).toContain('text-negative');
        expect(MOVEMENT_TYPE_META.return_out.badgeClass).toContain('text-negative');
    });
});

describe('movementQtyClass', () => {
    it('maps sign to color tokens', () => {
        expect(movementQtyClass(5)).toBe('text-positive');
        expect(movementQtyClass(-5)).toBe('text-negative');
        expect(movementQtyClass(0)).toBe('text-foreground-secondary');
    });
});

describe('quantity formatting', () => {
    it('trims trailing zeros up to 4 decimals', () => {
        expect(formatQty(5)).toBe('5');
        expect(formatQty(5.5)).toBe('5.5');
        expect(formatQty(5.12345)).toBe('5.1235'); // rounded at 4dp
        expect(formatQty(1234.5)).toBe('1,234.5');
    });

    it('never renders negative zero', () => {
        expect(formatQty(-0.00001)).toBe('0');
    });

    it('handles non-finite input', () => {
        expect(formatQty(NaN)).toBe('0');
        expect(formatQty(Infinity)).toBe('0');
    });

    it('adds explicit sign markers for signed display', () => {
        expect(formatSignedQty(3)).toBe('+3');
        expect(formatSignedQty(-2.5)).toBe('−2.5');
        expect(formatSignedQty(0)).toBe('0');
    });
});

describe('overview stats', () => {
    const items = [
        makeItem({ id: 1, active: true, onHand: 0, stockValue: 0 }),
        makeItem({ id: 2, active: true, onHand: 10, stockValue: 25.5 }),
        makeItem({ id: 3, active: true, onHand: -1, stockValue: 0 }),
        makeItem({ id: 4, active: false, onHand: 0, stockValue: 99 }),
    ];

    it('counts active items at or below zero stock', () => {
        expect(lowStockCount(items)).toBe(2); // ids 1 and 3; inactive id 4 excluded
    });

    it('sums stock value across active items only', () => {
        expect(totalStockValue(items)).toBeCloseTo(25.5);
    });
});

describe('compareItems', () => {
    const a = makeItem({ id: 1, sku: 'A-2', name: 'Alpha', onHand: 5, avgCost: 2, stockValue: 10, salePrice: null });
    const b = makeItem({ id: 2, sku: 'A-10', name: 'beta', onHand: 1, avgCost: 9, stockValue: 9, salePrice: 4 });

    it('sorts sku numerically (A-2 before A-10)', () => {
        expect(compareItems(a, b, 'sku', 'asc')).toBeLessThan(0);
        expect(compareItems(a, b, 'sku', 'desc')).toBeGreaterThan(0);
    });

    it('sorts names case-insensitively', () => {
        expect(compareItems(a, b, 'name', 'asc')).toBeLessThan(0);
    });

    it('sorts numeric columns by value', () => {
        expect(compareItems(a, b, 'onHand', 'asc')).toBeGreaterThan(0);
        expect(compareItems(a, b, 'stockValue', 'desc')).toBeLessThan(0);
    });

    it('sorts null sale prices before any real price ascending', () => {
        expect(compareItems(a, b, 'salePrice', 'asc')).toBeLessThan(0);
    });
});

describe('BOM demand math', () => {
    const bom = {
        outputQuantity: 2,
        lines: [
            { id: 1, bomId: 1, componentItemId: 10, quantity: 3 },
            { id: 2, bomId: 1, componentItemId: 11, quantity: 0.5 },
        ],
    };

    it('multiplies per-batch quantities by batches', () => {
        expect(computeBomDemand(bom, 4)).toEqual([
            { componentItemId: 10, required: 12 },
            { componentItemId: 11, required: 2 },
        ]);
    });

    it('rounds float drift to 4dp', () => {
        const demand = computeBomDemand(
            { lines: [{ id: 1, bomId: 1, componentItemId: 10, quantity: 0.1 }] },
            3,
        );
        expect(demand[0].required).toBe(0.3);
    });

    it('returns zero demand for non-positive batches', () => {
        expect(computeBomDemand(bom, 0)).toEqual([
            { componentItemId: 10, required: 0 },
            { componentItemId: 11, required: 0 },
        ]);
        expect(computeBomDemand(bom, NaN)[0].required).toBe(0);
    });

    it('computes output quantity', () => {
        expect(computeBomOutput(bom, 3)).toBe(6);
        expect(computeBomOutput(bom, 0)).toBe(0);
    });

    it('flags components whose demand exceeds on-hand stock', () => {
        const demand = computeBomDemand(bom, 4); // needs 12 of #10, 2 of #11
        const onHand = new Map<number, number>([[10, 12], [11, 1.5]]);
        const short = demandShortfalls(demand, onHand);
        expect(short.map((s) => s.componentItemId)).toEqual([11]);
    });

    it('treats unknown components as zero stock', () => {
        const demand = computeBomDemand(bom, 1);
        const short = demandShortfalls(demand, new Map());
        expect(short).toHaveLength(2);
    });
});

describe('defaultItemIdForEntry', () => {
    it('returns null when there are no movements', () => {
        expect(defaultItemIdForEntry({ movements: [] })).toBeNull();
    });

    it('uses the most recent movement item', () => {
        const entry = {
            movements: [
                makeMovement({ id: 1, itemId: 7 }),
                makeMovement({ id: 2, itemId: 9 }),
            ],
        };
        expect(defaultItemIdForEntry(entry)).toBe(9);
    });
});

describe('parseQty', () => {
    it('parses valid numbers including negatives', () => {
        expect(parseQty('5')).toBe(5);
        expect(parseQty('-2.5')).toBe(-2.5);
        expect(parseQty(' 3 ')).toBe(3);
    });

    it('returns null for blank or junk input', () => {
        expect(parseQty('')).toBeNull();
        expect(parseQty('   ')).toBeNull();
        expect(parseQty('abc')).toBeNull();
    });
});

describe('todayIso', () => {
    it('returns a YYYY-MM-DD string', () => {
        expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});
