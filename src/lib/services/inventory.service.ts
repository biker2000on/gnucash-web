/**
 * Inventory Service
 *
 * Owns the four shared tables for the Inventory Management feature:
 *   - gnucash_web_inventory_items      (one sellable/stockable item, per book)
 *   - gnucash_web_inventory_locations  (warehouses / bins, per book)
 *   - gnucash_web_inventory_movements  (append-only signed stock ledger)
 *   - gnucash_web_inventory_boms       (+ gnucash_web_inventory_bom_lines)
 *
 * All tables are created lazily via an advisory-lock guarded CREATE TABLE
 * (the same pattern as src/lib/notifications.ts) and are NOT part of the
 * Prisma schema — all access goes through prisma.$queryRawUnsafe.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * QUANTITY SIGN CONVENTION (shared with the inventory engine — do not deviate)
 * ─────────────────────────────────────────────────────────────────────────
 *   movements.quantity is SIGNED:
 *     • POSITIVE = stock INTO the (item, location)  — receive, transfer_in,
 *       assemble_produce, return_in, positive adjust
 *     • NEGATIVE = stock OUT of the (item, location) — ship, transfer_out,
 *       assemble_consume, return_out, negative adjust
 *   Stock on hand per (item, location) = SUM(quantity) and is never allowed
 *   to go below zero (the engine rejects with InventoryStockError → HTTP 409).
 *
 * VALUATION: per-item 'average' (default) or 'fifo', BOOK-WIDE (never
 * per-location). items.avg_cost is maintained on cost-bearing inbound
 * movements for every item (see applyMovementToAvgCost); FIFO items
 * additionally consume/post at layer-derived cost (see buildFifoLayers /
 * computeFifoConsumption in the engine) — avg_cost is informational there.
 */

import prisma from '@/lib/prisma';
import { createNotification, ensureNotificationsTable } from '@/lib/notifications';

// ---------------------------------------------------------------------------
// Errors (shared by service + engine + API routes)
// ---------------------------------------------------------------------------

/** Caller-fixable input problem — API routes map to HTTP 400. */
export class InventoryValidationError extends Error {}
/** Missing entity — HTTP 404. */
export class InventoryNotFoundError extends Error {}
/** Insufficient stock (movement would drive on-hand below zero) — HTTP 409. */
export class InventoryStockError extends Error {}
/** Valid request but conflicting state (e.g. duplicate SKU) — HTTP 409. */
export class InventoryStateError extends Error {}

// ---------------------------------------------------------------------------
// Types (camelCase in TS; snake_case in the DB)
// ---------------------------------------------------------------------------

export const VALUATION_METHODS = ['average', 'fifo'] as const;
export type ValuationMethod = (typeof VALUATION_METHODS)[number];

export const MOVEMENT_TYPES = [
  'receive',
  'ship',
  'adjust',
  'transfer_in',
  'transfer_out',
  'assemble_consume',
  'assemble_produce',
  'return_in',
  'return_out',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export interface InventoryItem {
  id: number;
  bookGuid: string;
  sku: string;
  name: string;
  description: string | null;
  unit: string;
  salePrice: number | null;
  incomeAccountGuid: string | null;
  cogsAccountGuid: string | null;
  assetAccountGuid: string | null;
  /**
   * Book-wide moving average cost. Always maintained (even for FIFO items,
   * where it is informational only — FIFO items consume/post at layer cost).
   */
  avgCost: number;
  /** 'average' (default) or 'fifo'. Affects future consumption only. */
  valuationMethod: ValuationMethod;
  /** Alert when total on-hand ≤ this (null = no reorder tracking). */
  reorderPoint: number | null;
  /** Suggested quantity to reorder (informational). */
  reorderQuantity: number | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface InventoryItemWithStock extends InventoryItem {
  /** SUM(quantity) across all locations. */
  onHand: number;
  /** onHand * avgCost. */
  stockValue: number;
}

export interface LocationStock {
  locationId: number;
  locationName: string;
  onHand: number;
}

export interface InventoryItemDetail extends InventoryItemWithStock {
  stockByLocation: LocationStock[];
}

export interface InventoryLocation {
  id: number;
  bookGuid: string;
  name: string;
  description: string | null;
  active: boolean;
  createdAt: Date;
}

export interface InventoryMovement {
  id: number;
  itemId: number;
  locationId: number;
  movementType: MovementType;
  /** Signed: positive = into stock at that location, negative = out. */
  quantity: number;
  /** Cost basis for receives/produce; null otherwise. */
  unitCost: number | null;
  /** ISO date 'YYYY-MM-DD'. */
  movementDate: string;
  reference: string | null;
  invoiceGuid: string | null;
  entryGuid: string | null;
  /** GnuCash transaction created when the operation was posted. */
  txnGuid: string | null;
  /** Pairing id for transfer_in/transfer_out. */
  counterpartMovementId: number | null;
  createdAt: Date;
}

export interface BomLine {
  id: number;
  bomId: number;
  componentItemId: number;
  quantity: number;
}

export interface Bom {
  id: number;
  /** Output item produced by this BOM. */
  itemId: number;
  name: string;
  outputQuantity: number;
  active: boolean;
  createdAt: Date;
  lines: BomLine[];
}

export interface CreateItemInput {
  sku: string;
  name: string;
  description?: string | null;
  unit?: string;
  salePrice?: number | null;
  incomeAccountGuid?: string | null;
  cogsAccountGuid?: string | null;
  assetAccountGuid?: string | null;
  valuationMethod?: ValuationMethod;
  reorderPoint?: number | null;
  reorderQuantity?: number | null;
}

export interface UpdateItemInput {
  sku?: string;
  name?: string;
  description?: string | null;
  unit?: string;
  salePrice?: number | null;
  incomeAccountGuid?: string | null;
  cogsAccountGuid?: string | null;
  assetAccountGuid?: string | null;
  valuationMethod?: ValuationMethod;
  reorderPoint?: number | null;
  reorderQuantity?: number | null;
  active?: boolean;
}

export interface CreateLocationInput {
  name: string;
  description?: string | null;
}

export interface UpdateLocationInput {
  name?: string;
  description?: string | null;
  active?: boolean;
}

export interface CreateBomInput {
  itemId: number;
  name: string;
  outputQuantity?: number;
  lines: Array<{ componentItemId: number; quantity: number }>;
}

export interface UpdateBomInput {
  name?: string;
  outputQuantity?: number;
  active?: boolean;
  lines?: Array<{ componentItemId: number; quantity: number }>;
}

export interface ListMovementsFilters {
  itemId?: number;
  locationId?: number;
  movementType?: MovementType;
  /** ISO date 'YYYY-MM-DD' inclusive. */
  dateFrom?: string;
  /** ISO date 'YYYY-MM-DD' inclusive. */
  dateTo?: string;
  invoiceGuid?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Row shapes (raw SQL) + mappers
// ---------------------------------------------------------------------------

/** Coerce a NUMERIC column (string | Prisma.Decimal | number | null) to number. */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isoDate(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
}

interface ItemRow {
  id: number;
  book_guid: string;
  sku: string;
  name: string;
  description: string | null;
  unit: string;
  sale_price: unknown;
  income_account_guid: string | null;
  cogs_account_guid: string | null;
  asset_account_guid: string | null;
  avg_cost: unknown;
  valuation_method: string;
  reorder_point: unknown;
  reorder_quantity: unknown;
  active: boolean;
  created_at: Date;
  updated_at: Date;
  on_hand?: unknown;
}

interface LocationRow {
  id: number;
  book_guid: string;
  name: string;
  description: string | null;
  active: boolean;
  created_at: Date;
}

interface MovementRow {
  id: number;
  item_id: number;
  location_id: number;
  movement_type: string;
  quantity: unknown;
  unit_cost: unknown;
  movement_date: Date | string;
  reference: string | null;
  invoice_guid: string | null;
  entry_guid: string | null;
  txn_guid: string | null;
  counterpart_movement_id: number | null;
  created_at: Date;
}

interface BomRow {
  id: number;
  item_id: number;
  name: string;
  output_quantity: unknown;
  active: boolean;
  created_at: Date;
}

interface BomLineRow {
  id: number;
  bom_id: number;
  component_item_id: number;
  quantity: unknown;
}

export function mapItemRow(row: ItemRow): InventoryItem {
  return {
    id: row.id,
    bookGuid: row.book_guid,
    sku: row.sku,
    name: row.name,
    description: row.description,
    unit: row.unit,
    salePrice: numOrNull(row.sale_price),
    incomeAccountGuid: row.income_account_guid,
    cogsAccountGuid: row.cogs_account_guid,
    assetAccountGuid: row.asset_account_guid,
    avgCost: num(row.avg_cost),
    valuationMethod: row.valuation_method === 'fifo' ? 'fifo' : 'average',
    reorderPoint: numOrNull(row.reorder_point),
    reorderQuantity: numOrNull(row.reorder_quantity),
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapItemRowWithStock(row: ItemRow): InventoryItemWithStock {
  const item = mapItemRow(row);
  const onHand = num(row.on_hand);
  return { ...item, onHand, stockValue: onHand * item.avgCost };
}

function mapLocationRow(row: LocationRow): InventoryLocation {
  return {
    id: row.id,
    bookGuid: row.book_guid,
    name: row.name,
    description: row.description,
    active: row.active,
    createdAt: row.created_at,
  };
}

export function mapMovementRow(row: MovementRow): InventoryMovement {
  return {
    id: row.id,
    itemId: row.item_id,
    locationId: row.location_id,
    movementType: row.movement_type as MovementType,
    quantity: num(row.quantity),
    unitCost: numOrNull(row.unit_cost),
    movementDate: isoDate(row.movement_date),
    reference: row.reference,
    invoiceGuid: row.invoice_guid,
    entryGuid: row.entry_guid,
    txnGuid: row.txn_guid,
    counterpartMovementId: row.counterpart_movement_id,
    createdAt: row.created_at,
  };
}

function mapBomRow(row: BomRow, lines: BomLineRow[]): Bom {
  return {
    id: row.id,
    itemId: row.item_id,
    name: row.name,
    outputQuantity: num(row.output_quantity),
    active: row.active,
    createdAt: row.created_at,
    lines: lines.map((l) => ({
      id: l.id,
      bomId: l.bom_id,
      componentItemId: l.component_item_id,
      quantity: num(l.quantity),
    })),
  };
}

const ITEM_COLS = `
  id, book_guid, sku, name, description, unit, sale_price,
  income_account_guid, cogs_account_guid, asset_account_guid,
  avg_cost, valuation_method, reorder_point, reorder_quantity,
  active, created_at, updated_at
`;

export const MOVEMENT_COLS = `
  id, item_id, location_id, movement_type, quantity, unit_cost,
  movement_date, reference, invoice_guid, entry_guid, txn_guid,
  counterpart_movement_id, created_at
`;

// ---------------------------------------------------------------------------
// Lazy table creation (advisory-lock guarded, mirrors notifications.ts)
// ---------------------------------------------------------------------------

let ensurePromise: Promise<void> | null = null;

export function ensureInventoryTables(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_inventory_schema'));

          CREATE TABLE IF NOT EXISTS gnucash_web_inventory_items (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            sku VARCHAR(64) NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            unit VARCHAR(16) NOT NULL DEFAULT 'ea',
            sale_price NUMERIC,
            income_account_guid VARCHAR(32),
            cogs_account_guid VARCHAR(32),
            asset_account_guid VARCHAR(32),
            avg_cost NUMERIC NOT NULL DEFAULT 0,
            active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (book_guid, sku)
          );

          CREATE TABLE IF NOT EXISTS gnucash_web_inventory_locations (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (book_guid, name)
          );

          CREATE TABLE IF NOT EXISTS gnucash_web_inventory_movements (
            id SERIAL PRIMARY KEY,
            item_id INTEGER NOT NULL,
            location_id INTEGER NOT NULL,
            movement_type VARCHAR(20) NOT NULL,
            quantity NUMERIC NOT NULL,
            unit_cost NUMERIC,
            movement_date DATE NOT NULL,
            reference TEXT,
            invoice_guid VARCHAR(32),
            entry_guid VARCHAR(32),
            txn_guid VARCHAR(32),
            counterpart_movement_id INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE INDEX IF NOT EXISTS idx_inventory_movements_item
            ON gnucash_web_inventory_movements(item_id);
          CREATE INDEX IF NOT EXISTS idx_inventory_movements_location
            ON gnucash_web_inventory_movements(location_id);
          CREATE INDEX IF NOT EXISTS idx_inventory_movements_invoice
            ON gnucash_web_inventory_movements(invoice_guid);

          CREATE TABLE IF NOT EXISTS gnucash_web_inventory_boms (
            id SERIAL PRIMARY KEY,
            item_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            output_quantity NUMERIC NOT NULL DEFAULT 1,
            active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE INDEX IF NOT EXISTS idx_inventory_boms_item
            ON gnucash_web_inventory_boms(item_id);

          CREATE TABLE IF NOT EXISTS gnucash_web_inventory_bom_lines (
            id SERIAL PRIMARY KEY,
            bom_id INTEGER NOT NULL,
            component_item_id INTEGER NOT NULL,
            quantity NUMERIC NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_inventory_bom_lines_bom
            ON gnucash_web_inventory_bom_lines(bom_id);

          -- v2 lazy column additions (reorder points + valuation method).
          ALTER TABLE gnucash_web_inventory_items
            ADD COLUMN IF NOT EXISTS reorder_point NUMERIC;
          ALTER TABLE gnucash_web_inventory_items
            ADD COLUMN IF NOT EXISTS reorder_quantity NUMERIC;
          ALTER TABLE gnucash_web_inventory_items
            ADD COLUMN IF NOT EXISTS valuation_method VARCHAR(10) NOT NULL DEFAULT 'average';
        END $$;
      `);
    })();
  }
  return ensurePromise;
}

// ---------------------------------------------------------------------------
// Small validation helpers
// ---------------------------------------------------------------------------

function isDuplicateKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('duplicate key') || message.includes('23505');
}

function validateIsoDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) {
    throw new InventoryValidationError(`Invalid ${field}: expected YYYY-MM-DD, got '${value}'`);
  }
  return value;
}

function validateNonNegativeOrNull(value: number | null | undefined, field: string): void {
  if (value != null && !(Number.isFinite(value) && value >= 0)) {
    throw new InventoryValidationError(`${field} must be a non-negative number`);
  }
}

function validateValuationMethod(value: string | undefined): void {
  if (value !== undefined && !VALUATION_METHODS.includes(value as ValuationMethod)) {
    throw new InventoryValidationError(
      `valuationMethod must be one of: ${VALUATION_METHODS.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function createItem(bookGuid: string, input: CreateItemInput): Promise<InventoryItem> {
  await ensureInventoryTables();
  const sku = (input.sku ?? '').trim();
  const name = (input.name ?? '').trim();
  if (!sku) throw new InventoryValidationError('sku is required');
  if (sku.length > 64) throw new InventoryValidationError('sku must be 64 characters or fewer');
  if (!name) throw new InventoryValidationError('name is required');
  if (input.salePrice != null && !(Number.isFinite(input.salePrice) && input.salePrice >= 0)) {
    throw new InventoryValidationError('salePrice must be a non-negative number');
  }
  validateNonNegativeOrNull(input.reorderPoint, 'reorderPoint');
  validateNonNegativeOrNull(input.reorderQuantity, 'reorderQuantity');
  validateValuationMethod(input.valuationMethod);

  try {
    const rows = await prisma.$queryRawUnsafe<ItemRow[]>(
      `
        INSERT INTO gnucash_web_inventory_items
          (book_guid, sku, name, description, unit, sale_price,
           income_account_guid, cogs_account_guid, asset_account_guid,
           valuation_method, reorder_point, reorder_quantity)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING ${ITEM_COLS}
      `,
      bookGuid,
      sku,
      name,
      input.description ?? null,
      (input.unit ?? 'ea').trim() || 'ea',
      input.salePrice ?? null,
      input.incomeAccountGuid ?? null,
      input.cogsAccountGuid ?? null,
      input.assetAccountGuid ?? null,
      input.valuationMethod ?? 'average',
      input.reorderPoint ?? null,
      input.reorderQuantity ?? null,
    );
    return mapItemRow(rows[0]);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new InventoryStateError(`An item with SKU '${sku}' already exists in this book`);
    }
    throw error;
  }
}

export async function updateItem(
  bookGuid: string,
  id: number,
  input: UpdateItemInput,
): Promise<InventoryItem> {
  await ensureInventoryTables();
  const existingRows = await prisma.$queryRawUnsafe<ItemRow[]>(
    `SELECT ${ITEM_COLS} FROM gnucash_web_inventory_items WHERE id = $1 AND book_guid = $2`,
    id,
    bookGuid,
  );
  if (existingRows.length === 0) throw new InventoryNotFoundError(`Item not found: ${id}`);
  const existing = mapItemRow(existingRows[0]);

  const sku = input.sku !== undefined ? input.sku.trim() : existing.sku;
  const name = input.name !== undefined ? input.name.trim() : existing.name;
  if (!sku) throw new InventoryValidationError('sku cannot be empty');
  if (!name) throw new InventoryValidationError('name cannot be empty');
  if (input.salePrice !== undefined && input.salePrice !== null &&
      !(Number.isFinite(input.salePrice) && input.salePrice >= 0)) {
    throw new InventoryValidationError('salePrice must be a non-negative number');
  }
  if (input.reorderPoint !== undefined) validateNonNegativeOrNull(input.reorderPoint, 'reorderPoint');
  if (input.reorderQuantity !== undefined) validateNonNegativeOrNull(input.reorderQuantity, 'reorderQuantity');
  validateValuationMethod(input.valuationMethod);

  try {
    const rows = await prisma.$queryRawUnsafe<ItemRow[]>(
      `
        UPDATE gnucash_web_inventory_items SET
          sku = $3,
          name = $4,
          description = $5,
          unit = $6,
          sale_price = $7,
          income_account_guid = $8,
          cogs_account_guid = $9,
          asset_account_guid = $10,
          active = $11,
          valuation_method = $12,
          reorder_point = $13,
          reorder_quantity = $14,
          updated_at = now()
        WHERE id = $1 AND book_guid = $2
        RETURNING ${ITEM_COLS}
      `,
      id,
      bookGuid,
      sku,
      name,
      input.description !== undefined ? input.description : existing.description,
      input.unit !== undefined ? (input.unit.trim() || 'ea') : existing.unit,
      input.salePrice !== undefined ? input.salePrice : existing.salePrice,
      input.incomeAccountGuid !== undefined ? input.incomeAccountGuid : existing.incomeAccountGuid,
      input.cogsAccountGuid !== undefined ? input.cogsAccountGuid : existing.cogsAccountGuid,
      input.assetAccountGuid !== undefined ? input.assetAccountGuid : existing.assetAccountGuid,
      input.active !== undefined ? input.active : existing.active,
      input.valuationMethod !== undefined ? input.valuationMethod : existing.valuationMethod,
      input.reorderPoint !== undefined ? input.reorderPoint : existing.reorderPoint,
      input.reorderQuantity !== undefined ? input.reorderQuantity : existing.reorderQuantity,
    );
    return mapItemRow(rows[0]);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new InventoryStateError(`An item with SKU '${sku}' already exists in this book`);
    }
    throw error;
  }
}

/** Soft-delete: sets active = false (movement history is preserved). */
export async function deactivateItem(bookGuid: string, id: number): Promise<InventoryItem> {
  return updateItem(bookGuid, id, { active: false });
}

export async function listItems(
  bookGuid: string,
  opts: { includeInactive?: boolean; search?: string } = {},
): Promise<InventoryItemWithStock[]> {
  await ensureInventoryTables();
  const params: unknown[] = [bookGuid];
  let where = 'i.book_guid = $1';
  if (!opts.includeInactive) where += ' AND i.active = true';
  if (opts.search) {
    params.push(`%${opts.search}%`);
    where += ` AND (i.sku ILIKE $${params.length} OR i.name ILIKE $${params.length})`;
  }
  const rows = await prisma.$queryRawUnsafe<ItemRow[]>(
    `
      SELECT i.id, i.book_guid, i.sku, i.name, i.description, i.unit, i.sale_price,
             i.income_account_guid, i.cogs_account_guid, i.asset_account_guid,
             i.avg_cost, i.valuation_method, i.reorder_point, i.reorder_quantity,
             i.active, i.created_at, i.updated_at,
             COALESCE(m.on_hand, 0) AS on_hand
      FROM gnucash_web_inventory_items i
      LEFT JOIN (
        SELECT item_id, SUM(quantity) AS on_hand
        FROM gnucash_web_inventory_movements
        GROUP BY item_id
      ) m ON m.item_id = i.id
      WHERE ${where}
      ORDER BY i.sku ASC
    `,
    ...params,
  );
  return rows.map(mapItemRowWithStock);
}

export async function getItem(bookGuid: string, id: number): Promise<InventoryItemDetail> {
  await ensureInventoryTables();
  const rows = await prisma.$queryRawUnsafe<ItemRow[]>(
    `
      SELECT i.id, i.book_guid, i.sku, i.name, i.description, i.unit, i.sale_price,
             i.income_account_guid, i.cogs_account_guid, i.asset_account_guid,
             i.avg_cost, i.valuation_method, i.reorder_point, i.reorder_quantity,
             i.active, i.created_at, i.updated_at,
             COALESCE((
               SELECT SUM(quantity) FROM gnucash_web_inventory_movements WHERE item_id = i.id
             ), 0) AS on_hand
      FROM gnucash_web_inventory_items i
      WHERE i.id = $1 AND i.book_guid = $2
    `,
    id,
    bookGuid,
  );
  if (rows.length === 0) throw new InventoryNotFoundError(`Item not found: ${id}`);

  const byLocation = await prisma.$queryRawUnsafe<
    Array<{ location_id: number; location_name: string; on_hand: unknown }>
  >(
    `
      SELECT l.id AS location_id, l.name AS location_name,
             COALESCE(SUM(mv.quantity), 0) AS on_hand
      FROM gnucash_web_inventory_movements mv
      JOIN gnucash_web_inventory_locations l ON l.id = mv.location_id
      WHERE mv.item_id = $1
      GROUP BY l.id, l.name
      ORDER BY l.name ASC
    `,
    id,
  );

  return {
    ...mapItemRowWithStock(rows[0]),
    stockByLocation: byLocation.map((r) => ({
      locationId: r.location_id,
      locationName: r.location_name,
      onHand: num(r.on_hand),
    })),
  };
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export async function createLocation(
  bookGuid: string,
  input: CreateLocationInput,
): Promise<InventoryLocation> {
  await ensureInventoryTables();
  const name = (input.name ?? '').trim();
  if (!name) throw new InventoryValidationError('name is required');
  try {
    const rows = await prisma.$queryRawUnsafe<LocationRow[]>(
      `
        INSERT INTO gnucash_web_inventory_locations (book_guid, name, description)
        VALUES ($1, $2, $3)
        RETURNING id, book_guid, name, description, active, created_at
      `,
      bookGuid,
      name,
      input.description ?? null,
    );
    return mapLocationRow(rows[0]);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new InventoryStateError(`A location named '${name}' already exists in this book`);
    }
    throw error;
  }
}

export async function updateLocation(
  bookGuid: string,
  id: number,
  input: UpdateLocationInput,
): Promise<InventoryLocation> {
  await ensureInventoryTables();
  const existingRows = await prisma.$queryRawUnsafe<LocationRow[]>(
    `SELECT id, book_guid, name, description, active, created_at
     FROM gnucash_web_inventory_locations WHERE id = $1 AND book_guid = $2`,
    id,
    bookGuid,
  );
  if (existingRows.length === 0) throw new InventoryNotFoundError(`Location not found: ${id}`);
  const existing = mapLocationRow(existingRows[0]);

  const name = input.name !== undefined ? input.name.trim() : existing.name;
  if (!name) throw new InventoryValidationError('name cannot be empty');

  try {
    const rows = await prisma.$queryRawUnsafe<LocationRow[]>(
      `
        UPDATE gnucash_web_inventory_locations SET
          name = $3, description = $4, active = $5
        WHERE id = $1 AND book_guid = $2
        RETURNING id, book_guid, name, description, active, created_at
      `,
      id,
      bookGuid,
      name,
      input.description !== undefined ? input.description : existing.description,
      input.active !== undefined ? input.active : existing.active,
    );
    return mapLocationRow(rows[0]);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new InventoryStateError(`A location named '${name}' already exists in this book`);
    }
    throw error;
  }
}

/** Soft-delete: sets active = false (movement history is preserved). */
export async function deactivateLocation(bookGuid: string, id: number): Promise<InventoryLocation> {
  return updateLocation(bookGuid, id, { active: false });
}

export async function listLocations(
  bookGuid: string,
  opts: { includeInactive?: boolean } = {},
): Promise<InventoryLocation[]> {
  await ensureInventoryTables();
  const rows = await prisma.$queryRawUnsafe<LocationRow[]>(
    `
      SELECT id, book_guid, name, description, active, created_at
      FROM gnucash_web_inventory_locations
      WHERE book_guid = $1 ${opts.includeInactive ? '' : 'AND active = true'}
      ORDER BY name ASC
    `,
    bookGuid,
  );
  return rows.map(mapLocationRow);
}

// ---------------------------------------------------------------------------
// Movements (read side; writes go through inventory-engine.ts)
// ---------------------------------------------------------------------------

export async function listMovements(
  bookGuid: string,
  filters: ListMovementsFilters = {},
): Promise<{ movements: InventoryMovement[]; total: number }> {
  await ensureInventoryTables();
  const params: unknown[] = [bookGuid];
  const conditions: string[] = ['i.book_guid = $1'];

  if (filters.itemId !== undefined) {
    params.push(filters.itemId);
    conditions.push(`mv.item_id = $${params.length}`);
  }
  if (filters.locationId !== undefined) {
    params.push(filters.locationId);
    conditions.push(`mv.location_id = $${params.length}`);
  }
  if (filters.movementType !== undefined) {
    if (!MOVEMENT_TYPES.includes(filters.movementType)) {
      throw new InventoryValidationError(`Invalid movementType: ${filters.movementType}`);
    }
    params.push(filters.movementType);
    conditions.push(`mv.movement_type = $${params.length}`);
  }
  if (filters.dateFrom) {
    params.push(validateIsoDate(filters.dateFrom, 'dateFrom'));
    conditions.push(`mv.movement_date >= $${params.length}::date`);
  }
  if (filters.dateTo) {
    params.push(validateIsoDate(filters.dateTo, 'dateTo'));
    conditions.push(`mv.movement_date <= $${params.length}::date`);
  }
  if (filters.invoiceGuid) {
    params.push(filters.invoiceGuid);
    conditions.push(`mv.invoice_guid = $${params.length}`);
  }

  const where = conditions.join(' AND ');
  const countRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `
      SELECT COUNT(*) AS count
      FROM gnucash_web_inventory_movements mv
      JOIN gnucash_web_inventory_items i ON i.id = mv.item_id
      WHERE ${where}
    `,
    ...params,
  );
  const total = Number(countRows[0]?.count ?? 0);

  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  params.push(limit, offset);
  const rows = await prisma.$queryRawUnsafe<MovementRow[]>(
    `
      SELECT mv.id, mv.item_id, mv.location_id, mv.movement_type, mv.quantity,
             mv.unit_cost, mv.movement_date, mv.reference, mv.invoice_guid,
             mv.entry_guid, mv.txn_guid, mv.counterpart_movement_id, mv.created_at
      FROM gnucash_web_inventory_movements mv
      JOIN gnucash_web_inventory_items i ON i.id = mv.item_id
      WHERE ${where}
      ORDER BY mv.movement_date DESC, mv.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    ...params,
  );
  return { movements: rows.map(mapMovementRow), total };
}

// ---------------------------------------------------------------------------
// BOMs
// ---------------------------------------------------------------------------

async function assertItemsInBook(bookGuid: string, itemIds: number[]): Promise<void> {
  if (itemIds.length === 0) return;
  const unique = Array.from(new Set(itemIds));
  const rows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
    `SELECT id FROM gnucash_web_inventory_items
     WHERE book_guid = $1 AND id = ANY($2::int[])`,
    bookGuid,
    unique,
  );
  const found = new Set(rows.map((r) => r.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new InventoryValidationError(`Item(s) not found in this book: ${missing.join(', ')}`);
  }
}

function validateBomLines(
  outputItemId: number,
  lines: Array<{ componentItemId: number; quantity: number }>,
): void {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new InventoryValidationError('A BOM requires at least one component line');
  }
  const seen = new Set<number>();
  for (const line of lines) {
    if (!Number.isInteger(line.componentItemId)) {
      throw new InventoryValidationError('componentItemId must be an integer');
    }
    if (line.componentItemId === outputItemId) {
      throw new InventoryValidationError('A BOM cannot consume its own output item');
    }
    if (seen.has(line.componentItemId)) {
      throw new InventoryValidationError(`Duplicate component item: ${line.componentItemId}`);
    }
    seen.add(line.componentItemId);
    if (!(Number.isFinite(line.quantity) && line.quantity > 0)) {
      throw new InventoryValidationError('Component quantity must be a positive number');
    }
  }
}

export async function createBom(bookGuid: string, input: CreateBomInput): Promise<Bom> {
  await ensureInventoryTables();
  const name = (input.name ?? '').trim();
  if (!name) throw new InventoryValidationError('name is required');
  const outputQuantity = input.outputQuantity ?? 1;
  if (!(Number.isFinite(outputQuantity) && outputQuantity > 0)) {
    throw new InventoryValidationError('outputQuantity must be a positive number');
  }
  validateBomLines(input.itemId, input.lines);
  await assertItemsInBook(bookGuid, [input.itemId, ...input.lines.map((l) => l.componentItemId)]);

  const bomId = await prisma.$transaction(async (tx) => {
    const bomRows = await tx.$queryRawUnsafe<BomRow[]>(
      `
        INSERT INTO gnucash_web_inventory_boms (item_id, name, output_quantity)
        VALUES ($1, $2, $3)
        RETURNING id, item_id, name, output_quantity, active, created_at
      `,
      input.itemId,
      name,
      outputQuantity,
    );
    const id = bomRows[0].id;
    for (const line of input.lines) {
      await tx.$executeRawUnsafe(
        `INSERT INTO gnucash_web_inventory_bom_lines (bom_id, component_item_id, quantity)
         VALUES ($1, $2, $3)`,
        id,
        line.componentItemId,
        line.quantity,
      );
    }
    return id;
  });

  return getBom(bookGuid, bomId);
}

export async function getBom(bookGuid: string, id: number): Promise<Bom> {
  await ensureInventoryTables();
  const bomRows = await prisma.$queryRawUnsafe<BomRow[]>(
    `
      SELECT b.id, b.item_id, b.name, b.output_quantity, b.active, b.created_at
      FROM gnucash_web_inventory_boms b
      JOIN gnucash_web_inventory_items i ON i.id = b.item_id
      WHERE b.id = $1 AND i.book_guid = $2
    `,
    id,
    bookGuid,
  );
  if (bomRows.length === 0) throw new InventoryNotFoundError(`BOM not found: ${id}`);
  const lines = await prisma.$queryRawUnsafe<BomLineRow[]>(
    `SELECT id, bom_id, component_item_id, quantity
     FROM gnucash_web_inventory_bom_lines WHERE bom_id = $1 ORDER BY id ASC`,
    id,
  );
  return mapBomRow(bomRows[0], lines);
}

export async function listBoms(
  bookGuid: string,
  opts: { includeInactive?: boolean; itemId?: number } = {},
): Promise<Bom[]> {
  await ensureInventoryTables();
  const params: unknown[] = [bookGuid];
  let where = 'i.book_guid = $1';
  if (!opts.includeInactive) where += ' AND b.active = true';
  if (opts.itemId !== undefined) {
    params.push(opts.itemId);
    where += ` AND b.item_id = $${params.length}`;
  }
  const bomRows = await prisma.$queryRawUnsafe<BomRow[]>(
    `
      SELECT b.id, b.item_id, b.name, b.output_quantity, b.active, b.created_at
      FROM gnucash_web_inventory_boms b
      JOIN gnucash_web_inventory_items i ON i.id = b.item_id
      WHERE ${where}
      ORDER BY b.name ASC
    `,
    ...params,
  );
  if (bomRows.length === 0) return [];
  const lineRows = await prisma.$queryRawUnsafe<BomLineRow[]>(
    `SELECT id, bom_id, component_item_id, quantity
     FROM gnucash_web_inventory_bom_lines
     WHERE bom_id = ANY($1::int[]) ORDER BY id ASC`,
    bomRows.map((b) => b.id),
  );
  const linesByBom = new Map<number, BomLineRow[]>();
  for (const line of lineRows) {
    const arr = linesByBom.get(line.bom_id) ?? [];
    arr.push(line);
    linesByBom.set(line.bom_id, arr);
  }
  return bomRows.map((b) => mapBomRow(b, linesByBom.get(b.id) ?? []));
}

export async function updateBom(bookGuid: string, id: number, input: UpdateBomInput): Promise<Bom> {
  const existing = await getBom(bookGuid, id);

  const name = input.name !== undefined ? input.name.trim() : existing.name;
  if (!name) throw new InventoryValidationError('name cannot be empty');
  const outputQuantity = input.outputQuantity !== undefined ? input.outputQuantity : existing.outputQuantity;
  if (!(Number.isFinite(outputQuantity) && outputQuantity > 0)) {
    throw new InventoryValidationError('outputQuantity must be a positive number');
  }
  if (input.lines) {
    validateBomLines(existing.itemId, input.lines);
    await assertItemsInBook(bookGuid, input.lines.map((l) => l.componentItemId));
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE gnucash_web_inventory_boms SET name = $2, output_quantity = $3, active = $4 WHERE id = $1`,
      id,
      name,
      outputQuantity,
      input.active !== undefined ? input.active : existing.active,
    );
    if (input.lines) {
      await tx.$executeRawUnsafe(`DELETE FROM gnucash_web_inventory_bom_lines WHERE bom_id = $1`, id);
      for (const line of input.lines) {
        await tx.$executeRawUnsafe(
          `INSERT INTO gnucash_web_inventory_bom_lines (bom_id, component_item_id, quantity)
           VALUES ($1, $2, $3)`,
          id,
          line.componentItemId,
          line.quantity,
        );
      }
    }
  });

  return getBom(bookGuid, id);
}

/** Soft-delete: sets active = false (assembly history references stay valid). */
export async function deactivateBom(bookGuid: string, id: number): Promise<Bom> {
  return updateBom(bookGuid, id, { active: false });
}

// ---------------------------------------------------------------------------
// Reorder-point scan (notifications, mirrors scanBudgetAlerts)
// ---------------------------------------------------------------------------

export const REORDER_ALERT_SOURCE = 'inventory-reorder';

/**
 * Stable dedupe key for a reorder alert: one notification per (item,
 * reorder point) breach. Raising the reorder point re-arms the alert;
 * restocking above the point and dipping below it again does NOT re-alert
 * until the point changes (matches the budget-alert scan's period-stable
 * key philosophy). Exported for tests.
 */
export function reorderDedupeKey(itemId: number, reorderPoint: number): string {
  return `item:${itemId}:below:${reorderPoint}`;
}

export interface ReorderScanOptions {
  /** Owner of the notifications to create. */
  userId: number;
  /** Max notifications to create in a single scan (default 20). */
  maxNotifications?: number;
}

interface ReorderScanRow {
  id: number;
  sku: string;
  name: string;
  unit: string;
  reorder_point: unknown;
  reorder_quantity: unknown;
  on_hand: unknown;
}

/**
 * Scan the book's active items with a reorder point set and create a
 * notification for each item whose total on-hand is at or below the point.
 * Deduped via (source='inventory-reorder', source_id=reorderDedupeKey(...)),
 * exactly like the budget-alert scan. Session-free and fire-and-forget safe:
 * never throws.
 */
export async function scanInventoryReorder(
  bookGuid: string,
  opts: ReorderScanOptions,
): Promise<{ detected: number; created: number }> {
  try {
    await ensureInventoryTables();
    const maxNotifications = opts.maxNotifications ?? 20;

    const rows = await prisma.$queryRawUnsafe<ReorderScanRow[]>(
      `
        SELECT i.id, i.sku, i.name, i.unit, i.reorder_point, i.reorder_quantity,
               COALESCE(m.on_hand, 0) AS on_hand
        FROM gnucash_web_inventory_items i
        LEFT JOIN (
          SELECT item_id, SUM(quantity) AS on_hand
          FROM gnucash_web_inventory_movements
          GROUP BY item_id
        ) m ON m.item_id = i.id
        WHERE i.book_guid = $1 AND i.active = true AND i.reorder_point IS NOT NULL
      `,
      bookGuid,
    );

    const low = rows.filter((r) => num(r.on_hand) <= num(r.reorder_point));
    if (low.length === 0) return { detected: 0, created: 0 };

    await ensureNotificationsTable();
    const existingRows = await prisma.$queryRaw<Array<{ source_id: string | null }>>`
      SELECT source_id
      FROM gnucash_web_notifications
      WHERE user_id = ${opts.userId}
        AND source = ${REORDER_ALERT_SOURCE}
        AND (book_guid IS NULL OR book_guid = ${bookGuid})
    `;
    const seen = new Set(existingRows.map((r) => r.source_id).filter((s): s is string => !!s));

    let created = 0;
    for (const row of low) {
      if (created >= maxNotifications) break;
      const reorderPoint = num(row.reorder_point);
      const key = reorderDedupeKey(row.id, reorderPoint);
      if (seen.has(key)) continue;
      seen.add(key);

      const onHand = num(row.on_hand);
      const reorderQty = numOrNull(row.reorder_quantity);
      await createNotification({
        userId: opts.userId,
        bookGuid,
        type: 'inventory_reorder',
        severity: 'warning',
        title: 'Inventory below reorder point',
        message:
          `${row.sku} — ${row.name}: ${onHand} ${row.unit} on hand ` +
          `(reorder point ${reorderPoint})` +
          (reorderQty != null ? `. Suggested reorder: ${reorderQty} ${row.unit}.` : '.'),
        href: `/business/inventory/${row.id}`,
        source: REORDER_ALERT_SOURCE,
        sourceId: key,
      });
      created++;
    }

    return { detected: low.length, created };
  } catch (error) {
    // Never let reorder scanning break the caller (e.g. the sync path).
    console.warn('Inventory reorder scan failed:', error);
    return { detected: 0, created: 0 };
  }
}
