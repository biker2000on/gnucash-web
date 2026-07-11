/**
 * Pure helpers + client-side DTO types for the Inventory Management UI.
 * No React imports — everything here is unit-testable.
 *
 * Server contracts live in src/lib/services/inventory.service.ts; the DTOs
 * below mirror the JSON the /api/inventory/* routes return (dates arrive as
 * strings over JSON, hence the separate client-side shapes).
 */

// ---------------------------------------------------------------------------
// DTO types (JSON shapes from /api/inventory/*)
// ---------------------------------------------------------------------------

export type MovementType =
    | 'receive'
    | 'ship'
    | 'adjust'
    | 'transfer_in'
    | 'transfer_out'
    | 'assemble_consume'
    | 'assemble_produce'
    | 'return_in'
    | 'return_out';

export type ValuationMethod = 'average' | 'fifo';

export interface ItemDTO {
    id: number;
    sku: string;
    name: string;
    description: string | null;
    unit: string;
    salePrice: number | null;
    incomeAccountGuid: string | null;
    cogsAccountGuid: string | null;
    assetAccountGuid: string | null;
    /** Book-wide moving average cost (informational for FIFO items). */
    avgCost: number;
    /** 'average' (default) or 'fifo'. Affects future consumption only. */
    valuationMethod: ValuationMethod;
    /** Alert when total on-hand ≤ this (null = no reorder tracking). */
    reorderPoint: number | null;
    /** Suggested quantity to reorder (informational). */
    reorderQuantity: number | null;
    active: boolean;
    onHand: number;
    stockValue: number;
}

export interface LocationStockDTO {
    locationId: number;
    locationName: string;
    onHand: number;
}

export interface ItemDetailDTO extends ItemDTO {
    stockByLocation: LocationStockDTO[];
}

export interface LocationDTO {
    id: number;
    name: string;
    description: string | null;
    active: boolean;
}

export interface MovementDTO {
    id: number;
    itemId: number;
    locationId: number;
    movementType: MovementType;
    /** Signed: positive = into stock at that location, negative = out. */
    quantity: number;
    unitCost: number | null;
    /** ISO date 'YYYY-MM-DD'. */
    movementDate: string;
    reference: string | null;
    invoiceGuid: string | null;
    entryGuid: string | null;
    txnGuid: string | null;
    counterpartMovementId: number | null;
}

export interface BomLineDTO {
    id: number;
    bomId: number;
    componentItemId: number;
    quantity: number;
}

export interface BomDTO {
    id: number;
    itemId: number;
    name: string;
    outputQuantity: number;
    active: boolean;
    lines: BomLineDTO[];
}

export interface FulfillmentEntryDTO {
    entryGuid: string;
    invoicedQuantity: number;
    fulfilledQuantity: number;
    remainingQuantity: number;
    movements: MovementDTO[];
}

export interface FulfillmentDTO {
    invoiceGuid: string;
    invoiceId: string;
    fullyFulfilled: boolean;
    entries: FulfillmentEntryDTO[];
}

export interface BillReceivingEntryDTO {
    entryGuid: string;
    billedQuantity: number;
    /** The bill entry's unit price — the receive cost basis. */
    unitCost: number;
    receivedQuantity: number;
    remainingQuantity: number;
    movements: MovementDTO[];
}

export interface BillReceivingDTO {
    billGuid: string;
    billId: string;
    fullyReceived: boolean;
    entries: BillReceivingEntryDTO[];
}

// ---------------------------------------------------------------------------
// Movement type presentation
// ---------------------------------------------------------------------------

export interface MovementTypeMeta {
    label: string;
    /** Flat tinted badge classes (matches STATUS_META in invoice-ui.ts). */
    badgeClass: string;
}

export const MOVEMENT_TYPE_META: Record<MovementType, MovementTypeMeta> = {
    receive: { label: 'Receive', badgeClass: 'bg-positive/10 text-positive' },
    ship: { label: 'Ship', badgeClass: 'bg-negative/10 text-negative' },
    adjust: { label: 'Adjust', badgeClass: 'bg-warning/10 text-warning' },
    transfer_in: { label: 'Transfer in', badgeClass: 'bg-secondary-light text-secondary' },
    transfer_out: { label: 'Transfer out', badgeClass: 'bg-secondary-light text-secondary' },
    assemble_consume: { label: 'Assembly use', badgeClass: 'bg-primary-light text-primary' },
    assemble_produce: { label: 'Assembled', badgeClass: 'bg-primary-light text-primary' },
    return_in: { label: 'Return in', badgeClass: 'bg-positive/10 text-positive' },
    return_out: { label: 'Return out', badgeClass: 'bg-negative/10 text-negative' },
};

export function movementTypeMeta(type: MovementType): MovementTypeMeta {
    return MOVEMENT_TYPE_META[type] ?? { label: type, badgeClass: 'bg-surface-hover text-foreground-muted' };
}

/** Color class for a signed movement quantity. */
export function movementQtyClass(quantity: number): string {
    if (quantity > 0) return 'text-positive';
    if (quantity < 0) return 'text-negative';
    return 'text-foreground-secondary';
}

// ---------------------------------------------------------------------------
// Quantity formatting
// ---------------------------------------------------------------------------

/** Format a quantity with up to 4 decimals, trailing zeros trimmed. */
export function formatQty(value: number): string {
    if (!Number.isFinite(value)) return '0';
    const rounded = Math.round(value * 10000) / 10000;
    // Avoid negative zero.
    const normalized = Object.is(rounded, -0) ? 0 : rounded;
    return normalized.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** Signed quantity display: explicit + for inbound, − (minus sign) for outbound. */
export function formatSignedQty(value: number): string {
    if (value > 0) return `+${formatQty(value)}`;
    if (value < 0) return `−${formatQty(Math.abs(value))}`;
    return '0';
}

// ---------------------------------------------------------------------------
// Overview stats
// ---------------------------------------------------------------------------

/** Count of active items at or below zero stock (low/zero-stock KPI). */
export function lowStockCount(items: Array<Pick<ItemDTO, 'active' | 'onHand'>>): number {
    return items.filter((i) => i.active && i.onHand <= 0).length;
}

/** True when the item tracks a reorder point and on-hand is at or below it. */
export function isBelowReorder(
    item: Pick<ItemDTO, 'reorderPoint' | 'onHand'>,
): boolean {
    return item.reorderPoint != null && item.onHand <= item.reorderPoint;
}

/** Count of active items at or below their reorder point. */
export function belowReorderCount(
    items: Array<Pick<ItemDTO, 'active' | 'reorderPoint' | 'onHand'>>,
): number {
    return items.filter((i) => i.active && isBelowReorder(i)).length;
}

/** Sum of stock value across active items (book-wide, at avg cost). */
export function totalStockValue(items: Array<Pick<ItemDTO, 'active' | 'stockValue'>>): number {
    return items.reduce((sum, i) => sum + (i.active ? i.stockValue : 0), 0);
}

// ---------------------------------------------------------------------------
// Items table sorting
// ---------------------------------------------------------------------------

export type ItemSortKey = 'sku' | 'name' | 'unit' | 'onHand' | 'avgCost' | 'stockValue' | 'salePrice';
export type SortDir = 'asc' | 'desc';

export function compareItems(a: ItemDTO, b: ItemDTO, key: ItemSortKey, dir: SortDir): number {
    const sign = dir === 'asc' ? 1 : -1;
    let cmp: number;
    switch (key) {
        case 'sku':
            cmp = a.sku.localeCompare(b.sku, undefined, { numeric: true, sensitivity: 'base' });
            break;
        case 'name':
            cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
            break;
        case 'unit':
            cmp = a.unit.localeCompare(b.unit, undefined, { sensitivity: 'base' });
            break;
        case 'onHand':
            cmp = a.onHand - b.onHand;
            break;
        case 'avgCost':
            cmp = a.avgCost - b.avgCost;
            break;
        case 'stockValue':
            cmp = a.stockValue - b.stockValue;
            break;
        case 'salePrice':
            cmp = (a.salePrice ?? -Infinity) - (b.salePrice ?? -Infinity);
            break;
        default:
            cmp = 0;
    }
    // Stable tie-break on sku so re-sorts don't shuffle equal rows.
    if (cmp === 0) cmp = a.sku.localeCompare(b.sku, undefined, { numeric: true });
    return cmp * sign;
}

// ---------------------------------------------------------------------------
// BOM demand math (mirrors the engine's assemble consumption)
// ---------------------------------------------------------------------------

export interface ComponentDemand {
    componentItemId: number;
    /** quantityPerBatch × batches. */
    required: number;
}

/** Per-component demand for assembling `batches` of a BOM. */
export function computeBomDemand(
    bom: Pick<BomDTO, 'lines'>,
    batches: number,
): ComponentDemand[] {
    if (!Number.isFinite(batches) || batches <= 0) {
        return bom.lines.map((l) => ({ componentItemId: l.componentItemId, required: 0 }));
    }
    return bom.lines.map((l) => ({
        componentItemId: l.componentItemId,
        // Round to 4dp to avoid float drift in the preview.
        required: Math.round(l.quantity * batches * 10000) / 10000,
    }));
}

/** Produced output quantity for `batches` of a BOM. */
export function computeBomOutput(bom: Pick<BomDTO, 'outputQuantity'>, batches: number): number {
    if (!Number.isFinite(batches) || batches <= 0) return 0;
    return Math.round(bom.outputQuantity * batches * 10000) / 10000;
}

/**
 * Components whose required quantity exceeds the available (book-wide) stock.
 * Advisory only — the engine enforces per-location stock and returns 409.
 */
export function demandShortfalls(
    demand: ComponentDemand[],
    onHandByItemId: Map<number, number>,
): ComponentDemand[] {
    return demand.filter((d) => d.required > (onHandByItemId.get(d.componentItemId) ?? 0));
}

// ---------------------------------------------------------------------------
// Fulfillment helpers
// ---------------------------------------------------------------------------

/**
 * Default item id for an invoice entry: the item used by its most recent
 * fulfillment movement, if any (entries carry no intrinsic item link).
 */
export function defaultItemIdForEntry(entry: Pick<FulfillmentEntryDTO, 'movements'>): number | null {
    if (entry.movements.length === 0) return null;
    return entry.movements[entry.movements.length - 1]?.itemId ?? entry.movements[0].itemId;
}

/** Today's date as YYYY-MM-DD in local time. */
export function todayIso(): string {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Parse a quantity input string; returns null when empty/invalid. */
export function parseQty(raw: string): number | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
}
