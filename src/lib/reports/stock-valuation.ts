/**
 * Stock Valuation report — current inventory on hand per item with the
 * item's valuation method, effective unit cost, and extended value.
 *
 * Valuation semantics (matches src/lib/inventory-engine.ts):
 *   - 'average' items: unit cost = items.avg_cost, value = onHand × avgCost.
 *   - 'fifo' items: remaining cost layers are rebuilt from the item's full
 *     movement history (oldest-first; transfers ignored); value = Σ layer
 *     remaining × layer cost, unit cost = value / onHand (0 when empty).
 *     avg_cost is still reported for display ("avg cost (info)").
 *
 * The report is point-in-time (current stock) — date filters do not apply.
 */

import prisma from '@/lib/prisma';
import { buildFifoLayers } from '@/lib/inventory-engine';
import {
  ensureInventoryTables,
  listLocations,
  MOVEMENT_COLS,
  mapMovementRow,
  type InventoryItemWithStock,
  type InventoryMovement,
  type ValuationMethod,
  listItems,
} from '@/lib/services/inventory.service';
import { ReportType, type ReportData, type ReportFilters, type ReportSection } from './types';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface StockValuationLocationRow {
  locationId: number;
  locationName: string;
  onHand: number;
  /** onHand × the item's effective unit cost. */
  value: number;
}

export interface StockValuationRow {
  itemId: number;
  sku: string;
  name: string;
  unit: string;
  method: ValuationMethod;
  onHand: number;
  /** Effective unit cost: avg cost (average) or FIFO layer-derived. */
  unitCost: number;
  /** Extended value: onHand × avgCost (average) or Σ remaining layers (FIFO). */
  value: number;
  /** The item's moving-average cost — informational for FIFO items. */
  avgCost: number;
  /** Per-location on-hand breakdown (valued at the effective unit cost). */
  locations: StockValuationLocationRow[];
}

export interface StockValuationData extends ReportData {
  type: ReportType.STOCK_VALUATION;
  items: StockValuationRow[];
  totals: {
    value: number;
    itemCount: number;
  };
}

/* ------------------------------------------------------------------ */
/* Pure aggregation (exported for unit tests)                          */
/* ------------------------------------------------------------------ */

const round2 = (n: number): number => {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
};

export interface StockValuationItemInput {
  id: number;
  sku: string;
  name: string;
  unit: string;
  valuationMethod: ValuationMethod;
  avgCost: number;
  onHand: number;
}

export type StockValuationMovementInput = Pick<
  InventoryMovement,
  'movementType' | 'quantity' | 'unitCost' | 'locationId'
>;

/**
 * Build valuation rows from item summaries + per-item movement histories
 * (each item's movements must be oldest-first). Items with zero on-hand and
 * zero value are still returned — the caller decides whether to hide them.
 */
export function buildStockValuationRows(
  items: ReadonlyArray<StockValuationItemInput>,
  movementsByItemId: ReadonlyMap<number, ReadonlyArray<StockValuationMovementInput>>,
  locationNames: ReadonlyMap<number, string>,
): StockValuationRow[] {
  return items.map((item) => {
    const movements = movementsByItemId.get(item.id) ?? [];

    let unitCost: number;
    let value: number;
    if (item.valuationMethod === 'fifo') {
      const layers = buildFifoLayers(movements);
      value = layers.reduce((sum, l) => sum + l.quantity * l.unitCost, 0);
      const layerQty = layers.reduce((sum, l) => sum + l.quantity, 0);
      unitCost = layerQty > 0 ? value / layerQty : 0;
    } else {
      unitCost = item.avgCost;
      value = item.onHand * item.avgCost;
    }

    // Per-location on-hand from the movement ledger.
    const byLocation = new Map<number, number>();
    for (const m of movements) {
      byLocation.set(m.locationId, (byLocation.get(m.locationId) ?? 0) + m.quantity);
    }
    const locations: StockValuationLocationRow[] = [...byLocation.entries()]
      .filter(([, onHand]) => Math.abs(onHand) > 1e-9)
      .map(([locationId, onHand]) => ({
        locationId,
        locationName: locationNames.get(locationId) ?? `#${locationId}`,
        onHand,
        value: round2(onHand * unitCost),
      }))
      .sort((a, b) => a.locationName.localeCompare(b.locationName));

    return {
      itemId: item.id,
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      method: item.valuationMethod,
      onHand: item.onHand,
      unitCost,
      value: round2(value),
      avgCost: item.avgCost,
      locations,
    };
  });
}

/** ReportData-compatible sections so the generic CSV/print helpers work. */
export function buildStockValuationSections(rows: StockValuationRow[]): ReportSection[] {
  return [
    {
      title: 'Inventory',
      items: rows.map((row) => ({
        guid: String(row.itemId),
        name: `${row.sku} — ${row.name}`,
        amount: row.value,
      })),
      total: round2(rows.reduce((sum, r) => sum + r.value, 0)),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* DB-bound generator                                                  */
/* ------------------------------------------------------------------ */

/**
 * Generate the Stock Valuation report for a book: every ACTIVE item, its
 * current on-hand, method-appropriate unit cost, and extended value, with a
 * per-location breakdown per item.
 */
export async function generateStockValuationReport(
  bookGuid: string,
  filters: ReportFilters,
): Promise<StockValuationData> {
  await ensureInventoryTables();

  const [items, locations] = await Promise.all([
    listItems(bookGuid),
    listLocations(bookGuid, { includeInactive: true }),
  ]);
  const locationNames = new Map(locations.map((l) => [l.id, l.name]));

  // One pass over the book's movements, oldest-first, grouped per item.
  const movementRows = await prisma.$queryRawUnsafe<Parameters<typeof mapMovementRow>[0][]>(
    `
      SELECT ${MOVEMENT_COLS.split(',').map((c) => `mv.${c.trim()}`).join(', ')}
      FROM gnucash_web_inventory_movements mv
      JOIN gnucash_web_inventory_items i ON i.id = mv.item_id
      WHERE i.book_guid = $1
      ORDER BY mv.item_id ASC, mv.id ASC
    `,
    bookGuid,
  );
  const movementsByItemId = new Map<number, InventoryMovement[]>();
  for (const row of movementRows) {
    const movement = mapMovementRow(row);
    const arr = movementsByItemId.get(movement.itemId) ?? [];
    arr.push(movement);
    movementsByItemId.set(movement.itemId, arr);
  }

  const inputs: StockValuationItemInput[] = items.map((item: InventoryItemWithStock) => ({
    id: item.id,
    sku: item.sku,
    name: item.name,
    unit: item.unit,
    valuationMethod: item.valuationMethod,
    avgCost: item.avgCost,
    onHand: item.onHand,
  }));

  const rows = buildStockValuationRows(inputs, movementsByItemId, locationNames);
  const totalValue = round2(rows.reduce((sum, r) => sum + r.value, 0));

  return {
    type: ReportType.STOCK_VALUATION,
    title: 'Stock Valuation',
    generatedAt: new Date().toISOString(),
    filters,
    items: rows,
    totals: { value: totalValue, itemCount: rows.length },
    sections: buildStockValuationSections(rows),
    grandTotal: totalValue,
  };
}
