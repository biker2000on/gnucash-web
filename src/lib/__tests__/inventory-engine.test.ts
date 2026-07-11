/**
 * Inventory Engine tests — pure valuation/stock math (DB-free).
 *
 * Covers: moving-average cost sequences, negative-stock rejection,
 * signed-quantity/type enforcement, transfer pairing, assembly costing,
 * and fulfillment/return allocation validation.
 */

import { describe, it, expect, vi } from 'vitest';

// The engine module imports prisma at module scope; stub it so tests never
// touch a database (only pure exports are exercised here).
vi.mock('@/lib/prisma', () => ({ default: {} }));

import {
  MOVEMENT_SIGN,
  signedQuantityForType,
  applyMovementToAvgCost,
  assertSufficientStock,
  computeAssemblyCost,
  validateFulfillmentAllocations,
  validateReturnAllocations,
  validateReceiveAllocations,
  buildFifoLayers,
  computeFifoConsumption,
  InventoryValidationError,
  InventoryStockError,
  type AssemblyComponentSpec,
  type FulfillmentAllocation,
  type FifoLayer,
} from '../inventory-engine';
import type { MovementType } from '../services/inventory.service';

// ---------------------------------------------------------------------------
// Signed quantity / movement-type enforcement
// ---------------------------------------------------------------------------

describe('signedQuantityForType', () => {
  it('applies positive sign to inbound types', () => {
    expect(signedQuantityForType('receive', 5)).toBe(5);
    expect(signedQuantityForType('transfer_in', 2)).toBe(2);
    expect(signedQuantityForType('assemble_produce', 3)).toBe(3);
    expect(signedQuantityForType('return_in', 1.5)).toBe(1.5);
  });

  it('applies negative sign to outbound types', () => {
    expect(signedQuantityForType('ship', 5)).toBe(-5);
    expect(signedQuantityForType('transfer_out', 2)).toBe(-2);
    expect(signedQuantityForType('assemble_consume', 3)).toBe(-3);
    expect(signedQuantityForType('return_out', 1.5)).toBe(-1.5);
  });

  it('passes signed adjust quantities through unchanged', () => {
    expect(signedQuantityForType('adjust', 4)).toBe(4);
    expect(signedQuantityForType('adjust', -3)).toBe(-3);
  });

  it('rejects zero or negative quantities for sign-implied types', () => {
    expect(() => signedQuantityForType('receive', 0)).toThrow(InventoryValidationError);
    expect(() => signedQuantityForType('receive', -5)).toThrow(InventoryValidationError);
    expect(() => signedQuantityForType('ship', -5)).toThrow(InventoryValidationError);
    expect(() => signedQuantityForType('return_out', 0)).toThrow(InventoryValidationError);
  });

  it('rejects zero adjust and non-finite quantities', () => {
    expect(() => signedQuantityForType('adjust', 0)).toThrow(InventoryValidationError);
    expect(() => signedQuantityForType('receive', NaN)).toThrow(InventoryValidationError);
    expect(() => signedQuantityForType('ship', Infinity)).toThrow(InventoryValidationError);
  });

  it('rejects unknown movement types', () => {
    expect(() =>
      signedQuantityForType('bogus' as Parameters<typeof signedQuantityForType>[0], 1),
    ).toThrow(InventoryValidationError);
  });

  it('pairs transfer_out/transfer_in to a net-zero quantity', () => {
    const qty = 7.25;
    const out = signedQuantityForType('transfer_out', qty);
    const inn = signedQuantityForType('transfer_in', qty);
    expect(out + inn).toBe(0);
    expect(out).toBeLessThan(0);
    expect(inn).toBeGreaterThan(0);
  });

  it('covers every movement type in MOVEMENT_SIGN', () => {
    expect(Object.keys(MOVEMENT_SIGN).sort()).toEqual(
      [
        'adjust',
        'assemble_consume',
        'assemble_produce',
        'receive',
        'return_in',
        'return_out',
        'ship',
        'transfer_in',
        'transfer_out',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Moving-average cost
// ---------------------------------------------------------------------------

describe('applyMovementToAvgCost', () => {
  it('sets the average to unitCost on the first receive (div0 guard)', () => {
    expect(applyMovementToAvgCost(0, 0, 'receive', 10, 5)).toBe(5);
  });

  it('computes the weighted average across sequential receives', () => {
    // receive 10 @ 5 → avg 5; receive 10 @ 10 → avg 7.5
    let avg = applyMovementToAvgCost(0, 0, 'receive', 10, 5);
    expect(avg).toBe(5);
    avg = applyMovementToAvgCost(avg, 10, 'receive', 10, 10);
    expect(avg).toBe(7.5);
  });

  it('leaves the average unchanged on consuming movements, then re-weights on re-receive', () => {
    // avg 7.5 with 20 on hand; ship 5 → avg unchanged, 15 remain
    let avg = 7.5;
    expect(applyMovementToAvgCost(avg, 20, 'ship', -5, null)).toBe(7.5);
    // re-receive 5 @ 2 with 15 on hand: (15*7.5 + 5*2) / 20 = 6.125
    avg = applyMovementToAvgCost(avg, 15, 'receive', 5, 2);
    expect(avg).toBeCloseTo(6.125, 10);
  });

  it('never changes the average for ship/assemble_consume/return_out/negative adjust', () => {
    expect(applyMovementToAvgCost(4, 10, 'ship', -3, 99)).toBe(4);
    expect(applyMovementToAvgCost(4, 10, 'assemble_consume', -3, 99)).toBe(4);
    expect(applyMovementToAvgCost(4, 10, 'return_out', -3, 99)).toBe(4);
    expect(applyMovementToAvgCost(4, 10, 'adjust', -3, 99)).toBe(4);
  });

  it('ignores transfers entirely (cost is book-wide)', () => {
    expect(applyMovementToAvgCost(4, 10, 'transfer_in', 3, 99)).toBe(4);
    expect(applyMovementToAvgCost(4, 10, 'transfer_out', -3, 99)).toBe(4);
  });

  it('leaves the average unchanged for inbound movements without a unitCost', () => {
    expect(applyMovementToAvgCost(4, 10, 'receive', 3, null)).toBe(4);
    expect(applyMovementToAvgCost(4, 10, 'receive', 3, undefined)).toBe(4);
  });

  it('updates on return_in, assemble_produce, and positive adjust with a unitCost', () => {
    // (10*4 + 10*6) / 20 = 5
    expect(applyMovementToAvgCost(4, 10, 'return_in', 10, 6)).toBe(5);
    expect(applyMovementToAvgCost(4, 10, 'assemble_produce', 10, 6)).toBe(5);
    expect(applyMovementToAvgCost(4, 10, 'adjust', 10, 6)).toBe(5);
  });

  it('treats zero/negative on-hand as a fresh start (guards corrupt totals)', () => {
    expect(applyMovementToAvgCost(4, 0, 'receive', 10, 6)).toBe(6);
    expect(applyMovementToAvgCost(4, -3, 'receive', 10, 6)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Negative-stock guard
// ---------------------------------------------------------------------------

describe('assertSufficientStock', () => {
  it('allows draws down to exactly zero', () => {
    expect(() => assertSufficientStock(10, -10)).not.toThrow();
    expect(() => assertSufficientStock(10, -5)).not.toThrow();
    expect(() => assertSufficientStock(0, 5)).not.toThrow();
  });

  it('rejects a movement that would drive stock below zero', () => {
    expect(() => assertSufficientStock(10, -10.5)).toThrow(InventoryStockError);
    expect(() => assertSufficientStock(0, -1)).toThrow(InventoryStockError);
  });

  it('tolerates floating-point residue near zero', () => {
    expect(() => assertSufficientStock(0.1 + 0.2, -0.3)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Assembly costing
// ---------------------------------------------------------------------------

describe('computeAssemblyCost', () => {
  const components: AssemblyComponentSpec[] = [
    { itemId: 1, quantityPerBatch: 2, avgCost: 3, onHandAtLocation: 10, label: 'FRAME' },
    { itemId: 2, quantityPerBatch: 1, avgCost: 4, onHandAtLocation: 5, label: 'WHEEL' },
  ];

  it('consumes components at avg cost and derives the produced unit cost', () => {
    // 2 batches, output 1/batch: consume 4×$3 + 2×$4 = $20 → 2 units @ $10
    const plan = computeAssemblyCost(components, 2, 1);
    expect(plan.consumptions).toEqual([
      { itemId: 1, quantity: -4, cost: 12 },
      { itemId: 2, quantity: -2, cost: 8 },
    ]);
    expect(plan.totalCost).toBe(20);
    expect(plan.producedQuantity).toBe(2);
    expect(plan.unitCost).toBe(10);
  });

  it('spreads cost across multi-unit output quantities', () => {
    // 1 batch producing 4 units: cost 2*3 + 1*4 = 10 → unit cost 2.5
    const plan = computeAssemblyCost(components, 1, 4);
    expect(plan.producedQuantity).toBe(4);
    expect(plan.unitCost).toBeCloseTo(2.5, 10);
  });

  it('supports fractional batches', () => {
    const plan = computeAssemblyCost(components, 0.5, 2);
    expect(plan.consumptions[0].quantity).toBe(-1);
    expect(plan.consumptions[1].quantity).toBe(-0.5);
    expect(plan.producedQuantity).toBe(1);
    expect(plan.totalCost).toBe(5);
  });

  it('rejects an assembly when any component lacks stock at the location', () => {
    // 6 batches needs 12 FRAME but only 10 on hand
    expect(() => computeAssemblyCost(components, 6, 1)).toThrow(InventoryStockError);
    expect(() => computeAssemblyCost(components, 6, 1)).toThrow(/FRAME/);
  });

  it('validates batches, output quantity, and component lines', () => {
    expect(() => computeAssemblyCost(components, 0, 1)).toThrow(InventoryValidationError);
    expect(() => computeAssemblyCost(components, -1, 1)).toThrow(InventoryValidationError);
    expect(() => computeAssemblyCost(components, 1, 0)).toThrow(InventoryValidationError);
    expect(() => computeAssemblyCost([], 1, 1)).toThrow(InventoryValidationError);
    expect(() =>
      computeAssemblyCost(
        [{ itemId: 1, quantityPerBatch: 0, avgCost: 1, onHandAtLocation: 10 }],
        1,
        1,
      ),
    ).toThrow(InventoryValidationError);
  });

  it('keeps consumption quantities negative (stock ledger sign convention)', () => {
    const plan = computeAssemblyCost(components, 1, 1);
    for (const c of plan.consumptions) expect(c.quantity).toBeLessThan(0);
    expect(plan.producedQuantity).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Fulfillment allocation validation
// ---------------------------------------------------------------------------

describe('validateFulfillmentAllocations', () => {
  const entryQuantities = new Map<string, number>([
    ['entryA', 5],
    ['entryB', 2],
  ]);

  const alloc = (
    entryGuid: string,
    quantity: number,
    overrides: Partial<FulfillmentAllocation> = {},
  ): FulfillmentAllocation => ({ entryGuid, itemId: 1, quantity, locationId: 1, ...overrides });

  it('accepts allocations within the invoiced quantities', () => {
    expect(() =>
      validateFulfillmentAllocations(
        [alloc('entryA', 3), alloc('entryB', 2)],
        entryQuantities,
        new Map(),
      ),
    ).not.toThrow();
  });

  it('rejects an empty allocation list', () => {
    expect(() => validateFulfillmentAllocations([], entryQuantities, new Map())).toThrow(
      InventoryValidationError,
    );
  });

  it('rejects entries that do not belong to the invoice', () => {
    expect(() =>
      validateFulfillmentAllocations([alloc('unknown', 1)], entryQuantities, new Map()),
    ).toThrow(/does not belong/);
  });

  it('rejects non-positive quantities', () => {
    expect(() =>
      validateFulfillmentAllocations([alloc('entryA', 0)], entryQuantities, new Map()),
    ).toThrow(InventoryValidationError);
    expect(() =>
      validateFulfillmentAllocations([alloc('entryA', -2)], entryQuantities, new Map()),
    ).toThrow(InventoryValidationError);
  });

  it('rejects over-fulfillment considering already fulfilled quantities', () => {
    const already = new Map([['entryA', 3]]);
    expect(() =>
      validateFulfillmentAllocations([alloc('entryA', 2)], entryQuantities, already),
    ).not.toThrow();
    expect(() =>
      validateFulfillmentAllocations([alloc('entryA', 2.5)], entryQuantities, already),
    ).toThrow(/exceeds the remaining quantity/);
  });

  it('sums multiple allocations against the same entry', () => {
    expect(() =>
      validateFulfillmentAllocations(
        [alloc('entryA', 3, { locationId: 1 }), alloc('entryA', 3, { locationId: 2 })],
        entryQuantities,
        new Map(),
      ),
    ).toThrow(/exceeds the remaining quantity/);
    expect(() =>
      validateFulfillmentAllocations(
        [alloc('entryA', 3, { locationId: 1 }), alloc('entryA', 2, { locationId: 2 })],
        entryQuantities,
        new Map(),
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FIFO layers
// ---------------------------------------------------------------------------

/** Shorthand movement for layer building. */
const mv = (
  movementType: MovementType,
  quantity: number,
  unitCost: number | null = null,
) => ({ movementType, quantity, unitCost });

describe('buildFifoLayers', () => {
  it('creates one layer per cost-bearing inbound movement, oldest-first', () => {
    const layers = buildFifoLayers([
      mv('receive', 10, 5),
      mv('receive', 4, 8),
    ]);
    expect(layers).toEqual([
      { quantity: 10, unitCost: 5 },
      { quantity: 4, unitCost: 8 },
    ]);
  });

  it('depletes layers oldest-first on consumption (partial + spanning)', () => {
    const layers = buildFifoLayers([
      mv('receive', 10, 5),
      mv('receive', 10, 8),
      mv('ship', -12), // wipes layer 1 (10) + 2 from layer 2
    ]);
    expect(layers).toEqual([{ quantity: 8, unitCost: 8 }]);
  });

  it('removes exactly depleted layers', () => {
    const layers = buildFifoLayers([
      mv('receive', 10, 5),
      mv('receive', 3, 7),
      mv('ship', -10),
    ]);
    expect(layers).toEqual([{ quantity: 3, unitCost: 7 }]);
  });

  it('ignores transfers entirely (paired location moves, book-wide cost)', () => {
    const layers = buildFifoLayers([
      mv('receive', 10, 5),
      mv('transfer_out', -6),
      mv('transfer_in', 6),
    ]);
    expect(layers).toEqual([{ quantity: 10, unitCost: 5 }]);
  });

  it('treats cost-less non-transfer inbound as a zero-cost layer', () => {
    const layers = buildFifoLayers([
      mv('adjust', 5, null),
      mv('receive', 5, 4),
    ]);
    expect(layers).toEqual([
      { quantity: 5, unitCost: 0 },
      { quantity: 5, unitCost: 4 },
    ]);
  });

  it('clamps consumption beyond available layers (pre-FIFO history guard)', () => {
    const layers = buildFifoLayers([
      mv('receive', 5, 5),
      mv('ship', -9), // 4 more than the layers cover
      mv('receive', 3, 6),
    ]);
    expect(layers).toEqual([{ quantity: 3, unitCost: 6 }]);
  });

  it('returns no layers for an empty history', () => {
    expect(buildFifoLayers([])).toEqual([]);
  });
});

describe('computeFifoConsumption', () => {
  const layers: FifoLayer[] = [
    { quantity: 10, unitCost: 5 },
    { quantity: 10, unitCost: 8 },
  ];

  it('consumes within a single layer at that layer cost', () => {
    const result = computeFifoConsumption(layers, 4);
    expect(result.totalCost).toBe(20);
    expect(result.unitCost).toBe(5);
    expect(result.breakdown).toEqual([{ quantity: 4, unitCost: 5 }]);
    expect(result.remaining).toEqual([
      { quantity: 6, unitCost: 5 },
      { quantity: 10, unitCost: 8 },
    ]);
  });

  it('weights the unit cost across spanned layers', () => {
    // 10 @ 5 + 5 @ 8 = 90 for 15 units → 6/unit
    const result = computeFifoConsumption(layers, 15);
    expect(result.totalCost).toBe(90);
    expect(result.unitCost).toBeCloseTo(6, 10);
    expect(result.breakdown).toEqual([
      { quantity: 10, unitCost: 5 },
      { quantity: 5, unitCost: 8 },
    ]);
    expect(result.remaining).toEqual([{ quantity: 5, unitCost: 8 }]);
  });

  it('exactly depletes all layers', () => {
    const result = computeFifoConsumption(layers, 20);
    expect(result.totalCost).toBe(130);
    expect(result.unitCost).toBeCloseTo(6.5, 10);
    expect(result.remaining).toEqual([]);
  });

  it('does not mutate the input layers', () => {
    computeFifoConsumption(layers, 15);
    expect(layers).toEqual([
      { quantity: 10, unitCost: 5 },
      { quantity: 10, unitCost: 8 },
    ]);
  });

  it('throws InventoryStockError when the quantity exceeds the layers', () => {
    expect(() => computeFifoConsumption(layers, 20.5)).toThrow(InventoryStockError);
    expect(() => computeFifoConsumption([], 1)).toThrow(InventoryStockError);
  });

  it('rejects non-positive / non-finite quantities', () => {
    expect(() => computeFifoConsumption(layers, 0)).toThrow(InventoryValidationError);
    expect(() => computeFifoConsumption(layers, -3)).toThrow(InventoryValidationError);
    expect(() => computeFifoConsumption(layers, NaN)).toThrow(InventoryValidationError);
  });

  it('round-trips with buildFifoLayers (avg vs FIFO divergence)', () => {
    // receive 10@5, 10@10 → avg would consume 8 at 7.5; FIFO consumes at 5.
    const built = buildFifoLayers([
      mv('receive', 10, 5),
      mv('receive', 10, 10),
    ]);
    expect(computeFifoConsumption(built, 8).unitCost).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Receive-against-bill allocation validation
// ---------------------------------------------------------------------------

describe('validateReceiveAllocations', () => {
  const entryQuantities = new Map<string, number>([
    ['entryA', 5],
    ['entryB', 2],
  ]);

  const alloc = (
    entryGuid: string,
    quantity: number,
    overrides: Partial<FulfillmentAllocation> = {},
  ): FulfillmentAllocation => ({ entryGuid, itemId: 1, quantity, locationId: 1, ...overrides });

  it('accepts allocations within the billed quantities', () => {
    expect(() =>
      validateReceiveAllocations(
        [alloc('entryA', 3), alloc('entryB', 2)],
        entryQuantities,
        new Map(),
      ),
    ).not.toThrow();
  });

  it('rejects an empty allocation list and unknown entries', () => {
    expect(() => validateReceiveAllocations([], entryQuantities, new Map())).toThrow(
      InventoryValidationError,
    );
    expect(() =>
      validateReceiveAllocations([alloc('unknown', 1)], entryQuantities, new Map()),
    ).toThrow(/does not belong/);
  });

  it('rejects non-positive quantities', () => {
    expect(() =>
      validateReceiveAllocations([alloc('entryA', 0)], entryQuantities, new Map()),
    ).toThrow(InventoryValidationError);
    expect(() =>
      validateReceiveAllocations([alloc('entryA', -2)], entryQuantities, new Map()),
    ).toThrow(InventoryValidationError);
  });

  it('rejects over-receiving considering already received quantities', () => {
    const already = new Map([['entryA', 3]]);
    expect(() =>
      validateReceiveAllocations([alloc('entryA', 2)], entryQuantities, already),
    ).not.toThrow();
    expect(() =>
      validateReceiveAllocations([alloc('entryA', 2.5)], entryQuantities, already),
    ).toThrow(/exceeds the remaining quantity/);
  });

  it('sums multiple allocations against the same entry', () => {
    expect(() =>
      validateReceiveAllocations(
        [alloc('entryA', 3, { locationId: 1 }), alloc('entryA', 3, { locationId: 2 })],
        entryQuantities,
        new Map(),
      ),
    ).toThrow(/exceeds the remaining quantity/);
    expect(() =>
      validateReceiveAllocations(
        [alloc('entryA', 3, { locationId: 1 }), alloc('entryA', 2, { locationId: 2 })],
        entryQuantities,
        new Map(),
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Return allocation validation
// ---------------------------------------------------------------------------

describe('validateReturnAllocations', () => {
  const fulfilled = new Map<string, number>([['entryA', 4]]);
  const alloc = (entryGuid: string, quantity: number): FulfillmentAllocation => ({
    entryGuid,
    itemId: 1,
    quantity,
    locationId: 1,
  });

  it('accepts returns up to the fulfilled quantity', () => {
    expect(() => validateReturnAllocations([alloc('entryA', 4)], fulfilled)).not.toThrow();
    expect(() => validateReturnAllocations([alloc('entryA', 1)], fulfilled)).not.toThrow();
  });

  it('rejects returns exceeding the fulfilled quantity (including cumulative)', () => {
    expect(() => validateReturnAllocations([alloc('entryA', 5)], fulfilled)).toThrow(
      /exceeds the fulfilled quantity/,
    );
    expect(() =>
      validateReturnAllocations([alloc('entryA', 3), alloc('entryA', 2)], fulfilled),
    ).toThrow(/exceeds the fulfilled quantity/);
  });

  it('rejects entries with no fulfillment and non-positive quantities', () => {
    expect(() => validateReturnAllocations([alloc('entryB', 1)], fulfilled)).toThrow(
      /no fulfillment/,
    );
    expect(() => validateReturnAllocations([alloc('entryA', 0)], fulfilled)).toThrow(
      InventoryValidationError,
    );
    expect(() => validateReturnAllocations([], fulfilled)).toThrow(InventoryValidationError);
  });
});
