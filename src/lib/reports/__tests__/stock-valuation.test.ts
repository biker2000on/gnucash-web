/**
 * Stock Valuation report tests — pure aggregation over item summaries and
 * movement histories (DB-free): average vs FIFO unit costs, extended values,
 * per-location breakdown, and the ReportData sections projection.
 */

import { describe, it, expect, vi } from 'vitest';

// stock-valuation imports prisma (directly and via the inventory engine and
// service); stub the externals so only pure exports are exercised.
vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/redis', () => ({ getRedis: () => null }));

import {
  buildStockValuationRows,
  buildStockValuationSections,
  type StockValuationItemInput,
  type StockValuationMovementInput,
} from '../stock-valuation';

const item = (overrides: Partial<StockValuationItemInput> = {}): StockValuationItemInput => ({
  id: 1,
  sku: 'WID-001',
  name: 'Widget',
  unit: 'ea',
  valuationMethod: 'average',
  avgCost: 5,
  onHand: 10,
  ...overrides,
});

const mv = (
  quantity: number,
  unitCost: number | null,
  locationId = 1,
  movementType: StockValuationMovementInput['movementType'] = quantity >= 0 ? 'receive' : 'ship',
): StockValuationMovementInput => ({ movementType, quantity, unitCost, locationId });

describe('buildStockValuationRows', () => {
  it('values average items at onHand × avgCost', () => {
    const rows = buildStockValuationRows(
      [item({ avgCost: 7.5, onHand: 4 })],
      new Map([[1, [mv(4, 7.5)]]]),
      new Map([[1, 'Main']]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe('average');
    expect(rows[0].unitCost).toBe(7.5);
    expect(rows[0].value).toBe(30);
  });

  it('values FIFO items from remaining layers (oldest consumed first)', () => {
    // receive 10 @ 5, receive 10 @ 10, ship 12 → remaining 8 @ 10 = 80.
    const movements = [mv(10, 5), mv(10, 10), mv(-12, null)];
    const rows = buildStockValuationRows(
      [item({ valuationMethod: 'fifo', avgCost: 7.5, onHand: 8 })],
      new Map([[1, movements]]),
      new Map([[1, 'Main']]),
    );
    expect(rows[0].method).toBe('fifo');
    expect(rows[0].value).toBe(80);
    expect(rows[0].unitCost).toBe(10);
    // avg cost stays reported for display ("avg cost (info)").
    expect(rows[0].avgCost).toBe(7.5);
  });

  it('diverges from average valuation for the same history', () => {
    const movements = [mv(10, 5), mv(10, 10), mv(-12, null)];
    const [avgRow] = buildStockValuationRows(
      [item({ valuationMethod: 'average', avgCost: 7.5, onHand: 8 })],
      new Map([[1, movements]]),
      new Map(),
    );
    const [fifoRow] = buildStockValuationRows(
      [item({ valuationMethod: 'fifo', avgCost: 7.5, onHand: 8 })],
      new Map([[1, movements]]),
      new Map(),
    );
    expect(avgRow.value).toBe(60); // 8 × 7.5
    expect(fifoRow.value).toBe(80); // remaining layer 8 × 10
  });

  it('reports zero unit cost and value for empty FIFO layers', () => {
    const rows = buildStockValuationRows(
      [item({ valuationMethod: 'fifo', onHand: 0 })],
      new Map([[1, [mv(5, 4), mv(-5, null)]]]),
      new Map(),
    );
    expect(rows[0].onHand).toBe(0);
    expect(rows[0].unitCost).toBe(0);
    expect(rows[0].value).toBe(0);
  });

  it('breaks stock out per location at the effective unit cost', () => {
    const movements = [
      mv(6, 5, 1),
      mv(4, 5, 2),
      mv(-2, null, 2),
    ];
    const rows = buildStockValuationRows(
      [item({ avgCost: 5, onHand: 8 })],
      new Map([[1, movements]]),
      new Map([[1, 'Warehouse'], [2, 'Storefront']]),
    );
    expect(rows[0].locations).toEqual([
      { locationId: 2, locationName: 'Storefront', onHand: 2, value: 10 },
      { locationId: 1, locationName: 'Warehouse', onHand: 6, value: 30 },
    ]);
  });

  it('omits zero-balance locations from the breakdown', () => {
    const movements = [mv(5, 5, 1), mv(-5, null, 1), mv(3, 5, 2)];
    const rows = buildStockValuationRows(
      [item({ avgCost: 5, onHand: 3 })],
      new Map([[1, movements]]),
      new Map([[1, 'A'], [2, 'B']]),
    );
    expect(rows[0].locations.map((l) => l.locationId)).toEqual([2]);
  });

  it('handles items with no movements at all', () => {
    const rows = buildStockValuationRows([item({ onHand: 0, avgCost: 0 })], new Map(), new Map());
    expect(rows[0].value).toBe(0);
    expect(rows[0].locations).toEqual([]);
  });
});

describe('buildStockValuationSections', () => {
  it('projects rows into a single section totalling the extended values', () => {
    const rows = buildStockValuationRows(
      [
        item({ id: 1, sku: 'A', name: 'Alpha', avgCost: 5, onHand: 2 }),
        item({ id: 2, sku: 'B', name: 'Beta', avgCost: 3, onHand: 4 }),
      ],
      new Map(),
      new Map(),
    );
    const sections = buildStockValuationSections(rows);
    expect(sections).toHaveLength(1);
    expect(sections[0].items.map((i) => i.name)).toEqual(['A — Alpha', 'B — Beta']);
    expect(sections[0].total).toBe(22); // 10 + 12
  });
});
