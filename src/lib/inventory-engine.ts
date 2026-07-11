/**
 * Inventory Engine
 *
 * Pure valuation/stock math + the mutating stock operations (receive, ship,
 * adjust, transfer, assemble, invoice fulfillment, return-to-stock). Each
 * mutating operation runs in a single prisma.$transaction and locks the
 * affected item row(s) with SELECT ... FOR UPDATE so avg-cost updates and
 * negative-stock guards are serialized.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * VALUATION (v1): moving average cost per item, BOOK-WIDE.
 * ─────────────────────────────────────────────────────────────────────────
 *   The average cost is NOT tracked per location — transferring stock
 *   between locations never changes cost. On a cost-bearing inbound movement
 *   ('receive' | 'return_in' | 'assemble_produce' | positive 'adjust' with a
 *   unitCost):
 *       newAvg = (onHandTotal * avgCost + qty * unitCost) / (onHandTotal + qty)
 *   (guarded against zero/negative denominators — see applyMovementToAvgCost).
 *   Outbound movements ('ship' | 'assemble_consume' | 'return_out' |
 *   negative 'adjust') consume at the current average cost and never change it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LEDGER POSTINGS (optional, per-operation `post: true`)
 * ─────────────────────────────────────────────────────────────────────────
 *   receive  → DEBIT item.asset_account_guid / CREDIT offsetAccountGuid
 *              (caller-supplied, e.g. A/P or checking), amount = qty*unitCost.
 *   ship     → DEBIT item.cogs_account_guid / CREDIT item.asset_account_guid,
 *              amount = qty*avgCost (COGS recognition).
 *   return   → DEBIT item.asset_account_guid / CREDIT item.cogs_account_guid,
 *              amount = qty*avgCost (reverses COGS).
 *   assemble → transfer txn moving consumed cost from each component's asset
 *              account into the output item's asset account; splits for
 *              components whose asset account equals the output's (or is
 *              unset) are skipped; the whole txn is skipped when nothing
 *              differs or the output asset account is unset.
 *   adjust / transfer → never post (no ledger transaction).
 *   If posting is requested but a required account is unset, the operation
 *   fails with InventoryValidationError (HTTP 400). Amounts that round to
 *   zero skip transaction creation (txnGuid stays null).
 *   Balanced 2-split GnuCash transactions are written in the SAME
 *   prisma.$transaction as the movement; the movement stores txn_guid.
 *
 * INVOICE FULFILLMENT is an EXPLICIT action — posting a customer invoice via
 * the invoice engine does NOT create stock movements automatically. Call
 * fulfillInvoiceLines() after the invoice is posted.
 */

import prisma from '@/lib/prisma';
import { generateGuid, fromDecimal, toDecimalNumber, findOrCreateAccount } from '@/lib/gnucash';
import {
  ensureInventoryTables,
  mapItemRow,
  mapMovementRow,
  MOVEMENT_COLS,
  InventoryValidationError,
  InventoryNotFoundError,
  InventoryStockError,
  InventoryStateError,
  type InventoryItem,
  type InventoryMovement,
  type MovementType,
} from '@/lib/services/inventory.service';

// Re-export the shared error classes so engine consumers can import from here.
export {
  InventoryValidationError,
  InventoryNotFoundError,
  InventoryStockError,
  InventoryStateError,
};

type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const EPSILON = 1e-9;
const SLOT_GDATE = 10;

// ---------------------------------------------------------------------------
// Pure math (DB-free, unit-tested)
// ---------------------------------------------------------------------------

/** +1 = inbound-only, -1 = outbound-only, 0 = either sign ('adjust'). */
export const MOVEMENT_SIGN: Record<MovementType, 1 | -1 | 0> = {
  receive: 1,
  transfer_in: 1,
  assemble_produce: 1,
  return_in: 1,
  ship: -1,
  transfer_out: -1,
  assemble_consume: -1,
  return_out: -1,
  adjust: 0,
};

/** Movement types that can carry a cost basis and update the moving average. */
const COST_BEARING_TYPES: ReadonlySet<MovementType> = new Set([
  'receive',
  'return_in',
  'assemble_produce',
  'adjust',
]);

/**
 * Convert a caller-supplied quantity into the SIGNED quantity stored on the
 * movement, enforcing the type's expected sign:
 *   - inbound/outbound types require a POSITIVE input quantity (the sign is
 *     applied by the type);
 *   - 'adjust' accepts a signed, non-zero quantity and passes it through.
 * Throws InventoryValidationError on violations.
 */
export function signedQuantityForType(movementType: MovementType, quantity: number): number {
  if (!Number.isFinite(quantity)) {
    throw new InventoryValidationError('quantity must be a finite number');
  }
  const sign = MOVEMENT_SIGN[movementType];
  if (sign === undefined) {
    throw new InventoryValidationError(`Invalid movement type: ${movementType}`);
  }
  if (sign === 0) {
    if (Math.abs(quantity) <= EPSILON) {
      throw new InventoryValidationError('adjust quantity must be non-zero');
    }
    return quantity;
  }
  if (quantity <= EPSILON) {
    throw new InventoryValidationError(
      `${movementType} quantity must be positive (the movement type implies the sign)`,
    );
  }
  return sign * quantity;
}

/**
 * Guard against negative stock: throws InventoryStockError (HTTP 409) when
 * applying signedDelta to onHand would drive the (item, location) below zero.
 */
export function assertSufficientStock(
  onHand: number,
  signedDelta: number,
  label = 'item',
): void {
  if (onHand + signedDelta < -EPSILON) {
    throw new InventoryStockError(
      `Insufficient stock for ${label}: on hand ${onHand}, requested change ${signedDelta}`,
    );
  }
}

/**
 * Moving-average cost update (book-wide, v1).
 *
 * @param currentAvgCost item's average cost BEFORE the movement
 * @param onHandTotal    item's total on-hand across ALL locations BEFORE the movement
 * @param movementType   the movement being applied
 * @param signedQuantity signed quantity as stored on the movement
 * @param unitCost       cost basis (receive/return_in/assemble_produce/positive adjust)
 * @returns the item's new average cost (unchanged for consuming movements,
 *          inbound movements without a unitCost, transfers, etc.)
 */
export function applyMovementToAvgCost(
  currentAvgCost: number,
  onHandTotal: number,
  movementType: MovementType,
  signedQuantity: number,
  unitCost: number | null | undefined,
): number {
  if (unitCost === null || unitCost === undefined) return currentAvgCost;
  if (!COST_BEARING_TYPES.has(movementType)) return currentAvgCost;
  if (signedQuantity <= EPSILON) return currentAvgCost; // outbound adjust consumes at avg
  const base = Math.max(onHandTotal, 0); // never let corrupt negative totals poison the avg
  const denom = base + signedQuantity;
  if (base <= EPSILON || denom <= EPSILON) return unitCost;
  return (base * currentAvgCost + signedQuantity * unitCost) / denom;
}

export interface AssemblyComponentSpec {
  itemId: number;
  /** Component quantity consumed per single batch (BOM line quantity). */
  quantityPerBatch: number;
  /** Component's current moving-average cost. */
  avgCost: number;
  /** Component's on-hand at the assembly location. */
  onHandAtLocation: number;
  /** For error messages. */
  label?: string;
}

export interface AssemblyPlan {
  consumptions: Array<{ itemId: number; quantity: number; cost: number }>; // quantity is NEGATIVE
  producedQuantity: number;
  totalCost: number;
  /** totalCost / producedQuantity — the produced units' cost basis. */
  unitCost: number;
}

/**
 * Assembly costing (pure): consume quantityPerBatch*batches of each component
 * at its current average cost; the produced units' unit cost is the total
 * consumed cost divided by the produced quantity. Throws InventoryStockError
 * when any component lacks stock at the assembly location.
 */
export function computeAssemblyCost(
  components: AssemblyComponentSpec[],
  batches: number,
  outputQuantity: number,
): AssemblyPlan {
  if (!(Number.isFinite(batches) && batches > 0)) {
    throw new InventoryValidationError('batches must be a positive number');
  }
  if (!(Number.isFinite(outputQuantity) && outputQuantity > 0)) {
    throw new InventoryValidationError('BOM outputQuantity must be a positive number');
  }
  if (!components || components.length === 0) {
    throw new InventoryValidationError('A BOM requires at least one component line');
  }

  const consumptions: AssemblyPlan['consumptions'] = [];
  let totalCost = 0;
  for (const c of components) {
    if (!(Number.isFinite(c.quantityPerBatch) && c.quantityPerBatch > 0)) {
      throw new InventoryValidationError(
        `Component ${c.label ?? c.itemId} has a non-positive BOM quantity`,
      );
    }
    const consumed = c.quantityPerBatch * batches;
    assertSufficientStock(c.onHandAtLocation, -consumed, c.label ?? `item ${c.itemId}`);
    const cost = consumed * c.avgCost;
    totalCost += cost;
    consumptions.push({ itemId: c.itemId, quantity: -consumed, cost });
  }

  const producedQuantity = outputQuantity * batches;
  return {
    consumptions,
    producedQuantity,
    totalCost,
    unitCost: totalCost / producedQuantity,
  };
}

export interface FulfillmentAllocation {
  entryGuid: string;
  itemId: number;
  quantity: number;
  locationId: number;
}

/**
 * Validate fulfillment allocations (pure):
 *   - every entryGuid must exist on the invoice (entryQuantities map);
 *   - quantities must be positive;
 *   - per entry, alreadyFulfilled + newly allocated must not exceed the
 *     invoice entry quantity.
 * Throws InventoryValidationError on violations.
 */
export function validateFulfillmentAllocations(
  allocations: FulfillmentAllocation[],
  entryQuantities: Map<string, number>,
  alreadyFulfilled: Map<string, number>,
): void {
  if (!allocations || allocations.length === 0) {
    throw new InventoryValidationError('At least one allocation is required');
  }
  const newByEntry = new Map<string, number>();
  for (const a of allocations) {
    if (!a.entryGuid) throw new InventoryValidationError('entryGuid is required on each allocation');
    if (!entryQuantities.has(a.entryGuid)) {
      throw new InventoryValidationError(`Entry ${a.entryGuid} does not belong to this invoice`);
    }
    if (!(Number.isFinite(a.quantity) && a.quantity > 0)) {
      throw new InventoryValidationError('Allocation quantity must be a positive number');
    }
    newByEntry.set(a.entryGuid, (newByEntry.get(a.entryGuid) ?? 0) + a.quantity);
  }
  for (const [entryGuid, newQty] of newByEntry) {
    const entryQty = entryQuantities.get(entryGuid) ?? 0;
    const fulfilled = alreadyFulfilled.get(entryGuid) ?? 0;
    if (fulfilled + newQty > entryQty + EPSILON) {
      throw new InventoryValidationError(
        `Entry ${entryGuid}: allocating ${newQty} exceeds the remaining quantity ` +
          `(${entryQty} on the invoice, ${fulfilled} already fulfilled)`,
      );
    }
  }
}

/**
 * Validate return allocations (pure): quantities positive, entry known, and
 * the return must not exceed what has been fulfilled (net shipped).
 */
export function validateReturnAllocations(
  allocations: FulfillmentAllocation[],
  fulfilledByEntry: Map<string, number>,
): void {
  if (!allocations || allocations.length === 0) {
    throw new InventoryValidationError('At least one allocation is required');
  }
  const newByEntry = new Map<string, number>();
  for (const a of allocations) {
    if (!a.entryGuid) throw new InventoryValidationError('entryGuid is required on each allocation');
    if (!fulfilledByEntry.has(a.entryGuid)) {
      throw new InventoryValidationError(
        `Entry ${a.entryGuid} has no fulfillment on this invoice to return`,
      );
    }
    if (!(Number.isFinite(a.quantity) && a.quantity > 0)) {
      throw new InventoryValidationError('Return quantity must be a positive number');
    }
    newByEntry.set(a.entryGuid, (newByEntry.get(a.entryGuid) ?? 0) + a.quantity);
  }
  for (const [entryGuid, qty] of newByEntry) {
    const fulfilled = fulfilledByEntry.get(entryGuid) ?? 0;
    if (qty > fulfilled + EPSILON) {
      throw new InventoryValidationError(
        `Entry ${entryGuid}: returning ${qty} exceeds the fulfilled quantity ${fulfilled}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Shared DB helpers (run inside a prisma.$transaction)
// ---------------------------------------------------------------------------

interface ItemRowRaw {
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
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

const ITEM_COLS = `
  id, book_guid, sku, name, description, unit, sale_price,
  income_account_guid, cogs_account_guid, asset_account_guid,
  avg_cost, active, created_at, updated_at
`;

/** Lock + load an item (FOR UPDATE serializes concurrent stock mutations). */
async function lockItem(
  tx: PrismaTx,
  bookGuid: string,
  itemId: number,
  opts: { requireActive?: boolean } = {},
): Promise<InventoryItem> {
  const rows = await tx.$queryRawUnsafe<ItemRowRaw[]>(
    `SELECT ${ITEM_COLS} FROM gnucash_web_inventory_items
     WHERE id = $1 AND book_guid = $2 FOR UPDATE`,
    itemId,
    bookGuid,
  );
  if (rows.length === 0) throw new InventoryNotFoundError(`Item not found: ${itemId}`);
  const item = mapItemRow(rows[0]);
  if (opts.requireActive !== false && !item.active) {
    throw new InventoryValidationError(`Item ${item.sku} is inactive`);
  }
  return item;
}

/** Lock + load several items in a deadlock-safe (id-ascending) order. */
async function lockItems(
  tx: PrismaTx,
  bookGuid: string,
  itemIds: number[],
): Promise<Map<number, InventoryItem>> {
  const unique = Array.from(new Set(itemIds)).sort((a, b) => a - b);
  const rows = await tx.$queryRawUnsafe<ItemRowRaw[]>(
    `SELECT ${ITEM_COLS} FROM gnucash_web_inventory_items
     WHERE book_guid = $1 AND id = ANY($2::int[])
     ORDER BY id ASC FOR UPDATE`,
    bookGuid,
    unique,
  );
  const map = new Map<number, InventoryItem>();
  for (const row of rows) map.set(row.id, mapItemRow(row));
  const missing = unique.filter((id) => !map.has(id));
  if (missing.length > 0) {
    throw new InventoryNotFoundError(`Item(s) not found: ${missing.join(', ')}`);
  }
  for (const item of map.values()) {
    if (!item.active) throw new InventoryValidationError(`Item ${item.sku} is inactive`);
  }
  return map;
}

async function assertLocation(
  tx: PrismaTx,
  bookGuid: string,
  locationId: number,
): Promise<{ id: number; name: string }> {
  const rows = await tx.$queryRawUnsafe<Array<{ id: number; name: string; active: boolean }>>(
    `SELECT id, name, active FROM gnucash_web_inventory_locations
     WHERE id = $1 AND book_guid = $2`,
    locationId,
    bookGuid,
  );
  if (rows.length === 0) throw new InventoryNotFoundError(`Location not found: ${locationId}`);
  if (!rows[0].active) throw new InventoryValidationError(`Location '${rows[0].name}' is inactive`);
  return { id: rows[0].id, name: rows[0].name };
}

async function getOnHand(
  tx: PrismaTx,
  itemId: number,
  locationId?: number,
): Promise<number> {
  const rows = locationId !== undefined
    ? await tx.$queryRawUnsafe<Array<{ total: unknown }>>(
        `SELECT COALESCE(SUM(quantity), 0) AS total
         FROM gnucash_web_inventory_movements WHERE item_id = $1 AND location_id = $2`,
        itemId,
        locationId,
      )
    : await tx.$queryRawUnsafe<Array<{ total: unknown }>>(
        `SELECT COALESCE(SUM(quantity), 0) AS total
         FROM gnucash_web_inventory_movements WHERE item_id = $1`,
        itemId,
      );
  return Number(rows[0]?.total ?? 0);
}

interface MovementInsert {
  itemId: number;
  locationId: number;
  movementType: MovementType;
  quantity: number;
  unitCost?: number | null;
  movementDate: string;
  reference?: string | null;
  invoiceGuid?: string | null;
  entryGuid?: string | null;
  txnGuid?: string | null;
  counterpartMovementId?: number | null;
}

async function insertMovement(tx: PrismaTx, m: MovementInsert): Promise<InventoryMovement> {
  const rows = await tx.$queryRawUnsafe<Parameters<typeof mapMovementRow>[0][]>(
    `
      INSERT INTO gnucash_web_inventory_movements
        (item_id, location_id, movement_type, quantity, unit_cost, movement_date,
         reference, invoice_guid, entry_guid, txn_guid, counterpart_movement_id)
      VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11)
      RETURNING ${MOVEMENT_COLS}
    `,
    m.itemId,
    m.locationId,
    m.movementType,
    m.quantity,
    m.unitCost ?? null,
    m.movementDate,
    m.reference ?? null,
    m.invoiceGuid ?? null,
    m.entryGuid ?? null,
    m.txnGuid ?? null,
    m.counterpartMovementId ?? null,
  );
  return mapMovementRow(rows[0]);
}

async function updateItemAvgCost(tx: PrismaTx, itemId: number, avgCost: number): Promise<void> {
  await tx.$executeRawUnsafe(
    `UPDATE gnucash_web_inventory_items SET avg_cost = $2, updated_at = now() WHERE id = $1`,
    itemId,
    avgCost,
  );
}

function parseMovementDate(value: string | undefined, field = 'date'): string {
  if (value === undefined) return new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InventoryValidationError(`Invalid ${field}: expected YYYY-MM-DD, got '${value}'`);
  }
  return value;
}

/** Resolve a currency for a GnuCash posting from an account's commodity. */
async function resolvePostingCurrency(
  tx: PrismaTx,
  accountGuid: string,
): Promise<{ guid: string; fraction: number }> {
  const account = await tx.accounts.findUnique({
    where: { guid: accountGuid },
    select: { guid: true, commodity_guid: true },
  });
  if (!account) throw new InventoryValidationError(`Account not found: ${accountGuid}`);
  if (account.commodity_guid) {
    const commodity = await tx.commodities.findUnique({
      where: { guid: account.commodity_guid },
      select: { guid: true, namespace: true, fraction: true },
    });
    if (commodity?.namespace === 'CURRENCY') {
      return { guid: commodity.guid, fraction: commodity.fraction || 100 };
    }
  }
  const usd = await tx.commodities.findFirst({
    where: { namespace: 'CURRENCY', mnemonic: 'USD' },
    select: { guid: true, fraction: true },
  });
  if (usd) return { guid: usd.guid, fraction: usd.fraction || 100 };
  const any = await tx.commodities.findFirst({
    where: { namespace: 'CURRENCY' },
    select: { guid: true, fraction: true },
  });
  if (!any) throw new InventoryValidationError('No currency commodity found in this book');
  return { guid: any.guid, fraction: any.fraction || 100 };
}

async function assertPostableAccount(tx: PrismaTx, guid: string, label: string): Promise<void> {
  const account = await tx.accounts.findUnique({
    where: { guid },
    select: { guid: true, placeholder: true },
  });
  if (!account) throw new InventoryValidationError(`${label} account not found: ${guid}`);
  if (account.placeholder === 1) {
    throw new InventoryValidationError(`${label} account ${guid} is a placeholder`);
  }
}

interface SplitSpec {
  accountGuid: string;
  /** Signed currency value (positive = debit, negative = credit). */
  value: number;
  memo?: string;
}

/**
 * Write a balanced GnuCash transaction (same pattern as invoice-engine
 * postInvoice: noon-UTC post date, 'date-posted' gdate slot, value==quantity
 * splits in the account currency). Returns null when every split rounds to 0.
 */
async function writeLedgerTxn(
  tx: PrismaTx,
  input: { date: string; description: string; splits: SplitSpec[] },
): Promise<string | null> {
  const currency = await resolvePostingCurrency(tx, input.splits[0].accountGuid);
  const rounded = input.splits.map((s) => ({
    ...s,
    frac: fromDecimal(s.value, currency.fraction),
  }));
  if (rounded.every((s) => s.frac.num === 0n)) return null;

  const txnGuid = generateGuid();
  const postDate = new Date(input.date + 'T12:00:00Z');
  await tx.transactions.create({
    data: {
      guid: txnGuid,
      currency_guid: currency.guid,
      num: '',
      post_date: postDate,
      enter_date: new Date(),
      description: input.description,
    },
  });
  await tx.slots.create({
    data: {
      obj_guid: txnGuid,
      name: 'date-posted',
      slot_type: SLOT_GDATE,
      gdate_val: new Date(input.date + 'T00:00:00Z'),
    },
  });
  for (const s of rounded) {
    await tx.splits.create({
      data: {
        guid: generateGuid(),
        tx_guid: txnGuid,
        account_guid: s.accountGuid,
        memo: s.memo ?? '',
        action: '',
        reconcile_state: 'n',
        reconcile_date: null,
        value_num: s.frac.num,
        value_denom: s.frac.denom,
        quantity_num: s.frac.num,
        quantity_denom: s.frac.denom,
        lot_guid: null,
      },
    });
  }
  return txnGuid;
}

// ---------------------------------------------------------------------------
// Account bootstrap
// ---------------------------------------------------------------------------

/**
 * Create (or find) the default 'Inventory' ASSET and 'Cost of Goods Sold'
 * EXPENSE accounts under the book root. Call this on demand (e.g. from a UI
 * "set up inventory accounts" action) and assign the returned guids to items.
 */
export async function bootstrapInventoryAccounts(
  bookRootGuid: string,
): Promise<{ assetAccountGuid: string; cogsAccountGuid: string }> {
  let result: { assetAccountGuid: string; cogsAccountGuid: string } | null = null;
  await prisma.$transaction(async (tx) => {
    const root = await tx.accounts.findUnique({
      where: { guid: bookRootGuid },
      select: { guid: true, commodity_guid: true },
    });
    if (!root) throw new InventoryNotFoundError(`Book root account not found: ${bookRootGuid}`);
    const currency = await resolvePostingCurrency(tx, bookRootGuid);

    const assetGuid = await findOrCreateAccount('Inventory', bookRootGuid, currency.guid, tx);
    await tx.accounts.update({
      where: { guid: assetGuid },
      data: { account_type: 'ASSET', placeholder: 0, description: 'Inventory on hand' },
    });

    const cogsGuid = await findOrCreateAccount('Cost of Goods Sold', bookRootGuid, currency.guid, tx);
    await tx.accounts.update({
      where: { guid: cogsGuid },
      data: { account_type: 'EXPENSE', placeholder: 0, description: 'Cost of Goods Sold' },
    });

    result = { assetAccountGuid: assetGuid, cogsAccountGuid: cogsGuid };
  });
  return result!;
}

// ---------------------------------------------------------------------------
// Mutating operations
// ---------------------------------------------------------------------------

export interface MovementResult {
  movement: InventoryMovement;
  /** Item state AFTER the movement (updated avgCost). */
  item: InventoryItem;
  /** GnuCash transaction created when post=true (null otherwise/zero-amount). */
  txnGuid: string | null;
}

export interface ReceiveInput {
  bookGuid: string;
  itemId: number;
  locationId: number;
  /** Positive quantity received. */
  quantity: number;
  /** Cost per unit; required when post=true, optional otherwise. */
  unitCost?: number | null;
  /** ISO 'YYYY-MM-DD'; defaults to today. */
  date?: string;
  reference?: string | null;
  /** Write a GnuCash txn: debit item.assetAccountGuid / credit offsetAccountGuid. */
  post?: boolean;
  /** Required when post=true (e.g. A/P or checking account guid). */
  offsetAccountGuid?: string | null;
}

export async function receiveStock(input: ReceiveInput): Promise<MovementResult> {
  await ensureInventoryTables();
  const signedQty = signedQuantityForType('receive', input.quantity);
  const date = parseMovementDate(input.date);
  if (input.unitCost != null && !(Number.isFinite(input.unitCost) && input.unitCost >= 0)) {
    throw new InventoryValidationError('unitCost must be a non-negative number');
  }
  if (input.post) {
    if (input.unitCost == null) {
      throw new InventoryValidationError('unitCost is required when posting a receive to the ledger');
    }
    if (!input.offsetAccountGuid) {
      throw new InventoryValidationError('offsetAccountGuid is required when posting a receive to the ledger');
    }
  }

  let result: MovementResult | null = null;
  await prisma.$transaction(async (tx) => {
    const item = await lockItem(tx, input.bookGuid, input.itemId);
    await assertLocation(tx, input.bookGuid, input.locationId);

    let txnGuid: string | null = null;
    if (input.post) {
      if (!item.assetAccountGuid) {
        throw new InventoryValidationError(
          `Item ${item.sku} has no asset account configured — set assetAccountGuid before posting`,
        );
      }
      await assertPostableAccount(tx, item.assetAccountGuid, 'Asset');
      await assertPostableAccount(tx, input.offsetAccountGuid!, 'Offset');
      const amount = input.quantity * (input.unitCost ?? 0);
      txnGuid = await writeLedgerTxn(tx, {
        date,
        description: `Inventory receive: ${item.sku} × ${input.quantity}`,
        splits: [
          { accountGuid: item.assetAccountGuid, value: amount, memo: input.reference ?? '' },
          { accountGuid: input.offsetAccountGuid!, value: -amount, memo: input.reference ?? '' },
        ],
      });
    }

    const onHandTotal = await getOnHand(tx, item.id);
    const newAvg = applyMovementToAvgCost(item.avgCost, onHandTotal, 'receive', signedQty, input.unitCost);
    if (newAvg !== item.avgCost) await updateItemAvgCost(tx, item.id, newAvg);

    const movement = await insertMovement(tx, {
      itemId: item.id,
      locationId: input.locationId,
      movementType: 'receive',
      quantity: signedQty,
      unitCost: input.unitCost ?? null,
      movementDate: date,
      reference: input.reference ?? null,
      txnGuid,
    });
    result = { movement, item: { ...item, avgCost: newAvg }, txnGuid };
  });
  return result!;
}

export interface ShipInput {
  bookGuid: string;
  itemId: number;
  locationId: number;
  /** Positive quantity shipped. */
  quantity: number;
  date?: string;
  reference?: string | null;
  /** Write a GnuCash txn: debit item.cogsAccountGuid / credit item.assetAccountGuid. */
  post?: boolean;
  /** Internal: link to an invoice entry (used by fulfillInvoiceLines). */
  invoiceGuid?: string | null;
  entryGuid?: string | null;
}

export async function shipStock(input: ShipInput): Promise<MovementResult> {
  await ensureInventoryTables();
  const signedQty = signedQuantityForType('ship', input.quantity);
  const date = parseMovementDate(input.date);

  let result: MovementResult | null = null;
  await prisma.$transaction(async (tx) => {
    const item = await lockItem(tx, input.bookGuid, input.itemId);
    await assertLocation(tx, input.bookGuid, input.locationId);
    const onHandAtLocation = await getOnHand(tx, item.id, input.locationId);
    assertSufficientStock(onHandAtLocation, signedQty, item.sku);

    const txnGuid = await maybePostCogs(tx, item, input.quantity, date, input.post, input.reference);

    const movement = await insertMovement(tx, {
      itemId: item.id,
      locationId: input.locationId,
      movementType: 'ship',
      quantity: signedQty,
      movementDate: date,
      reference: input.reference ?? null,
      invoiceGuid: input.invoiceGuid ?? null,
      entryGuid: input.entryGuid ?? null,
      txnGuid,
    });
    result = { movement, item, txnGuid };
  });
  return result!;
}

/** Shared COGS posting for ship/fulfillment (debit COGS, credit asset). */
async function maybePostCogs(
  tx: PrismaTx,
  item: InventoryItem,
  positiveQty: number,
  date: string,
  post: boolean | undefined,
  reference: string | null | undefined,
): Promise<string | null> {
  if (!post) return null;
  if (!item.cogsAccountGuid || !item.assetAccountGuid) {
    throw new InventoryValidationError(
      `Item ${item.sku} needs both cogsAccountGuid and assetAccountGuid configured before posting COGS`,
    );
  }
  await assertPostableAccount(tx, item.cogsAccountGuid, 'COGS');
  await assertPostableAccount(tx, item.assetAccountGuid, 'Asset');
  const amount = positiveQty * item.avgCost;
  return writeLedgerTxn(tx, {
    date,
    description: `COGS: ${item.sku} × ${positiveQty}`,
    splits: [
      { accountGuid: item.cogsAccountGuid, value: amount, memo: reference ?? '' },
      { accountGuid: item.assetAccountGuid, value: -amount, memo: reference ?? '' },
    ],
  });
}

/** Reverse-COGS posting for returns (debit asset, credit COGS). */
async function maybePostReturn(
  tx: PrismaTx,
  item: InventoryItem,
  positiveQty: number,
  date: string,
  post: boolean | undefined,
  reference: string | null | undefined,
): Promise<string | null> {
  if (!post) return null;
  if (!item.cogsAccountGuid || !item.assetAccountGuid) {
    throw new InventoryValidationError(
      `Item ${item.sku} needs both cogsAccountGuid and assetAccountGuid configured before posting a return`,
    );
  }
  await assertPostableAccount(tx, item.cogsAccountGuid, 'COGS');
  await assertPostableAccount(tx, item.assetAccountGuid, 'Asset');
  const amount = positiveQty * item.avgCost;
  return writeLedgerTxn(tx, {
    date,
    description: `Inventory return: ${item.sku} × ${positiveQty}`,
    splits: [
      { accountGuid: item.assetAccountGuid, value: amount, memo: reference ?? '' },
      { accountGuid: item.cogsAccountGuid, value: -amount, memo: reference ?? '' },
    ],
  });
}

export interface AdjustInput {
  bookGuid: string;
  itemId: number;
  locationId: number;
  /** SIGNED quantity: positive adds stock, negative removes it. Non-zero. */
  quantity: number;
  /** Optional cost basis for POSITIVE adjustments (feeds the moving average). */
  unitCost?: number | null;
  date?: string;
  reference?: string | null;
}

/** Adjustments never post to the ledger (physical count corrections). */
export async function adjustStock(input: AdjustInput): Promise<MovementResult> {
  await ensureInventoryTables();
  const signedQty = signedQuantityForType('adjust', input.quantity);
  const date = parseMovementDate(input.date);
  if (input.unitCost != null && !(Number.isFinite(input.unitCost) && input.unitCost >= 0)) {
    throw new InventoryValidationError('unitCost must be a non-negative number');
  }

  let result: MovementResult | null = null;
  await prisma.$transaction(async (tx) => {
    const item = await lockItem(tx, input.bookGuid, input.itemId);
    await assertLocation(tx, input.bookGuid, input.locationId);
    if (signedQty < 0) {
      const onHandAtLocation = await getOnHand(tx, item.id, input.locationId);
      assertSufficientStock(onHandAtLocation, signedQty, item.sku);
    }

    const onHandTotal = await getOnHand(tx, item.id);
    const newAvg = applyMovementToAvgCost(item.avgCost, onHandTotal, 'adjust', signedQty, input.unitCost);
    if (newAvg !== item.avgCost) await updateItemAvgCost(tx, item.id, newAvg);

    const movement = await insertMovement(tx, {
      itemId: item.id,
      locationId: input.locationId,
      movementType: 'adjust',
      quantity: signedQty,
      unitCost: input.unitCost ?? null,
      movementDate: date,
      reference: input.reference ?? null,
    });
    result = { movement, item: { ...item, avgCost: newAvg }, txnGuid: null };
  });
  return result!;
}

export interface TransferInput {
  bookGuid: string;
  itemId: number;
  fromLocationId: number;
  toLocationId: number;
  /** Positive quantity to move. */
  quantity: number;
  date?: string;
  reference?: string | null;
}

export interface TransferResult {
  outMovement: InventoryMovement;
  inMovement: InventoryMovement;
}

/**
 * Paired transfer_out/transfer_in movements linked via counterpart_movement_id.
 * No ledger transaction (cost is book-wide; location moves are cost-neutral).
 */
export async function transferStock(input: TransferInput): Promise<TransferResult> {
  await ensureInventoryTables();
  if (input.fromLocationId === input.toLocationId) {
    throw new InventoryValidationError('fromLocationId and toLocationId must differ');
  }
  if (!(Number.isFinite(input.quantity) && input.quantity > 0)) {
    throw new InventoryValidationError('transfer quantity must be positive');
  }
  const date = parseMovementDate(input.date);

  let result: TransferResult | null = null;
  await prisma.$transaction(async (tx) => {
    const item = await lockItem(tx, input.bookGuid, input.itemId);
    await assertLocation(tx, input.bookGuid, input.fromLocationId);
    await assertLocation(tx, input.bookGuid, input.toLocationId);

    const onHandAtFrom = await getOnHand(tx, item.id, input.fromLocationId);
    assertSufficientStock(onHandAtFrom, -input.quantity, item.sku);

    const outMovement = await insertMovement(tx, {
      itemId: item.id,
      locationId: input.fromLocationId,
      movementType: 'transfer_out',
      quantity: -input.quantity,
      movementDate: date,
      reference: input.reference ?? null,
    });
    const inMovement = await insertMovement(tx, {
      itemId: item.id,
      locationId: input.toLocationId,
      movementType: 'transfer_in',
      quantity: input.quantity,
      movementDate: date,
      reference: input.reference ?? null,
      counterpartMovementId: outMovement.id,
    });
    await tx.$executeRawUnsafe(
      `UPDATE gnucash_web_inventory_movements SET counterpart_movement_id = $2 WHERE id = $1`,
      outMovement.id,
      inMovement.id,
    );
    result = {
      outMovement: { ...outMovement, counterpartMovementId: inMovement.id },
      inMovement,
    };
  });
  return result!;
}

export interface AssembleInput {
  bookGuid: string;
  bomId: number;
  /** Number of BOM batches to build (positive; fractional allowed). */
  batches: number;
  /** Location components are consumed from and output is produced at. */
  locationId: number;
  date?: string;
  reference?: string | null;
  /**
   * Write a GnuCash transfer txn moving consumed cost from component asset
   * accounts into the output item's asset account (skipped for same/unset
   * accounts — see module header).
   */
  post?: boolean;
}

export interface AssembleResult {
  consumed: InventoryMovement[];
  produced: InventoryMovement;
  totalCost: number;
  /** Cost basis of each produced unit (totalCost / producedQuantity). */
  unitCost: number;
  producedQuantity: number;
  txnGuid: string | null;
  /** Shared reference stamped on all movements of this assembly run. */
  reference: string;
}

export async function assembleBom(input: AssembleInput): Promise<AssembleResult> {
  await ensureInventoryTables();
  const date = parseMovementDate(input.date);

  let result: AssembleResult | null = null;
  await prisma.$transaction(async (tx) => {
    const bomRows = await tx.$queryRawUnsafe<
      Array<{ id: number; item_id: number; name: string; output_quantity: unknown; active: boolean }>
    >(
      `SELECT b.id, b.item_id, b.name, b.output_quantity, b.active
       FROM gnucash_web_inventory_boms b
       JOIN gnucash_web_inventory_items i ON i.id = b.item_id
       WHERE b.id = $1 AND i.book_guid = $2`,
      input.bomId,
      input.bookGuid,
    );
    if (bomRows.length === 0) throw new InventoryNotFoundError(`BOM not found: ${input.bomId}`);
    const bom = bomRows[0];
    if (!bom.active) throw new InventoryValidationError(`BOM '${bom.name}' is inactive`);

    const lineRows = await tx.$queryRawUnsafe<
      Array<{ component_item_id: number; quantity: unknown }>
    >(
      `SELECT component_item_id, quantity FROM gnucash_web_inventory_bom_lines
       WHERE bom_id = $1 ORDER BY id ASC`,
      input.bomId,
    );
    if (lineRows.length === 0) {
      throw new InventoryValidationError(`BOM '${bom.name}' has no component lines`);
    }

    await assertLocation(tx, input.bookGuid, input.locationId);

    // Lock output + all components in id order (deadlock-safe).
    const allItemIds = [bom.item_id, ...lineRows.map((l) => l.component_item_id)];
    const items = await lockItems(tx, input.bookGuid, allItemIds);
    const outputItem = items.get(bom.item_id)!;

    const componentSpecs: AssemblyComponentSpec[] = [];
    for (const line of lineRows) {
      const component = items.get(line.component_item_id)!;
      componentSpecs.push({
        itemId: component.id,
        quantityPerBatch: Number(line.quantity),
        avgCost: component.avgCost,
        onHandAtLocation: await getOnHand(tx, component.id, input.locationId),
        label: component.sku,
      });
    }

    const plan = computeAssemblyCost(componentSpecs, input.batches, Number(bom.output_quantity));
    const reference = input.reference ?? `ASM-${bom.id}-${Date.now()}`;

    // Optional ledger transfer: consumed cost → output item's asset account.
    let txnGuid: string | null = null;
    if (input.post && outputItem.assetAccountGuid) {
      const splits: SplitSpec[] = [];
      let transferred = 0;
      for (const consumption of plan.consumptions) {
        const component = items.get(consumption.itemId)!;
        if (
          component.assetAccountGuid &&
          component.assetAccountGuid !== outputItem.assetAccountGuid &&
          consumption.cost > 0
        ) {
          splits.push({
            accountGuid: component.assetAccountGuid,
            value: -consumption.cost,
            memo: reference,
          });
          transferred += consumption.cost;
        }
      }
      if (splits.length > 0 && transferred > 0) {
        await assertPostableAccount(tx, outputItem.assetAccountGuid, 'Asset');
        for (const s of splits) await assertPostableAccount(tx, s.accountGuid, 'Asset');
        splits.unshift({
          accountGuid: outputItem.assetAccountGuid,
          value: transferred,
          memo: reference,
        });
        txnGuid = await writeLedgerTxn(tx, {
          date,
          description: `Assembly: ${bom.name} × ${input.batches}`,
          splits,
        });
      }
    }

    // Consume components at their current average cost.
    const consumed: InventoryMovement[] = [];
    for (const consumption of plan.consumptions) {
      consumed.push(
        await insertMovement(tx, {
          itemId: consumption.itemId,
          locationId: input.locationId,
          movementType: 'assemble_consume',
          quantity: consumption.quantity,
          movementDate: date,
          reference,
          txnGuid,
        }),
      );
    }

    // Produce output at the derived unit cost (updates the output's average).
    const outputOnHandTotal = await getOnHand(tx, outputItem.id);
    const newAvg = applyMovementToAvgCost(
      outputItem.avgCost,
      outputOnHandTotal,
      'assemble_produce',
      plan.producedQuantity,
      plan.unitCost,
    );
    if (newAvg !== outputItem.avgCost) await updateItemAvgCost(tx, outputItem.id, newAvg);

    const produced = await insertMovement(tx, {
      itemId: outputItem.id,
      locationId: input.locationId,
      movementType: 'assemble_produce',
      quantity: plan.producedQuantity,
      unitCost: plan.unitCost,
      movementDate: date,
      reference,
      txnGuid,
    });

    result = {
      consumed,
      produced,
      totalCost: plan.totalCost,
      unitCost: plan.unitCost,
      producedQuantity: plan.producedQuantity,
      txnGuid,
      reference,
    };
  });
  return result!;
}

// ---------------------------------------------------------------------------
// Invoice fulfillment
// ---------------------------------------------------------------------------

const OWNER_TYPE_CUSTOMER = 2;
const OWNER_TYPE_JOB = 3;

interface InvoiceForFulfillment {
  guid: string;
  id: string;
  entryQuantities: Map<string, number>;
}

/** Load + validate a POSTED customer invoice (job-owned resolving to a customer allowed). */
async function loadPostedCustomerInvoice(
  tx: PrismaTx,
  invoiceGuid: string,
): Promise<InvoiceForFulfillment> {
  const invoice = await tx.invoices.findUnique({ where: { guid: invoiceGuid } });
  if (!invoice) throw new InventoryNotFoundError(`Invoice not found: ${invoiceGuid}`);

  let isCustomerInvoice = invoice.owner_type === OWNER_TYPE_CUSTOMER;
  if (invoice.owner_type === OWNER_TYPE_JOB && invoice.owner_guid) {
    const job = await tx.jobs.findUnique({
      where: { guid: invoice.owner_guid },
      select: { owner_type: true },
    });
    isCustomerInvoice = job?.owner_type === OWNER_TYPE_CUSTOMER;
  }
  if (!isCustomerInvoice) {
    throw new InventoryValidationError('Fulfillment is only supported for customer invoices');
  }
  if (!invoice.post_txn) {
    throw new InventoryStateError(`Invoice ${invoice.id} is not posted — post it before fulfilling`);
  }

  const entryRows: Array<{ guid: string; quantity_num: bigint | null; quantity_denom: bigint | null }> =
    await tx.entries.findMany({
      where: { invoice: invoiceGuid },
      select: { guid: true, quantity_num: true, quantity_denom: true },
    });
  const entryQuantities = new Map<string, number>();
  for (const row of entryRows) {
    entryQuantities.set(row.guid, toDecimalNumber(row.quantity_num, row.quantity_denom));
  }
  return { guid: invoice.guid, id: invoice.id, entryQuantities };
}

/** Net fulfilled quantity per entry = -(SUM of ship + return_in movement quantities). */
async function getFulfilledByEntry(
  tx: PrismaTx,
  invoiceGuid: string,
): Promise<Map<string, number>> {
  const rows = await tx.$queryRawUnsafe<Array<{ entry_guid: string | null; total: unknown }>>(
    `SELECT entry_guid, SUM(quantity) AS total
     FROM gnucash_web_inventory_movements
     WHERE invoice_guid = $1 AND movement_type IN ('ship', 'return_in')
     GROUP BY entry_guid`,
    invoiceGuid,
  );
  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.entry_guid) map.set(row.entry_guid, -Number(row.total ?? 0));
  }
  return map;
}

export interface FulfillInput {
  bookGuid: string;
  invoiceGuid: string;
  allocations: FulfillmentAllocation[];
  date?: string;
  /** Post COGS per allocation (debit item COGS / credit item asset at avgCost). */
  post?: boolean;
}

export interface FulfillResult {
  invoiceGuid: string;
  movements: InventoryMovement[];
}

/**
 * Fulfill (ship) lines of a POSTED customer invoice: creates 'ship' movements
 * linked via invoice_guid + entry_guid, with optional COGS posting. An entry
 * may be fulfilled across several calls/locations, but never beyond its
 * invoiced quantity.
 */
export async function fulfillInvoiceLines(input: FulfillInput): Promise<FulfillResult> {
  await ensureInventoryTables();
  const date = parseMovementDate(input.date);

  let result: FulfillResult | null = null;
  await prisma.$transaction(async (tx) => {
    const invoice = await loadPostedCustomerInvoice(tx, input.invoiceGuid);
    const alreadyFulfilled = await getFulfilledByEntry(tx, input.invoiceGuid);
    validateFulfillmentAllocations(input.allocations, invoice.entryQuantities, alreadyFulfilled);

    const items = await lockItems(tx, input.bookGuid, input.allocations.map((a) => a.itemId));
    for (const a of input.allocations) await assertLocation(tx, input.bookGuid, a.locationId);

    // Aggregate stock demand per (item, location) so multi-allocation requests
    // cannot overdraw by splitting a single shortage across allocations.
    const demand = new Map<string, { itemId: number; locationId: number; qty: number }>();
    for (const a of input.allocations) {
      const key = `${a.itemId}:${a.locationId}`;
      const d = demand.get(key) ?? { itemId: a.itemId, locationId: a.locationId, qty: 0 };
      d.qty += a.quantity;
      demand.set(key, d);
    }
    for (const d of demand.values()) {
      const onHand = await getOnHand(tx, d.itemId, d.locationId);
      assertSufficientStock(onHand, -d.qty, items.get(d.itemId)!.sku);
    }

    const reference = `Invoice ${invoice.id}`;
    const movements: InventoryMovement[] = [];
    for (const a of input.allocations) {
      const item = items.get(a.itemId)!;
      const txnGuid = await maybePostCogs(tx, item, a.quantity, date, input.post, reference);
      movements.push(
        await insertMovement(tx, {
          itemId: item.id,
          locationId: a.locationId,
          movementType: 'ship',
          quantity: -a.quantity,
          movementDate: date,
          reference,
          invoiceGuid: input.invoiceGuid,
          entryGuid: a.entryGuid,
          txnGuid,
        }),
      );
    }
    result = { invoiceGuid: input.invoiceGuid, movements };
  });
  return result!;
}

/**
 * Return previously fulfilled invoice lines to stock: creates 'return_in'
 * movements (positive quantity, unit cost = the item's current average cost,
 * which leaves the average unchanged) linked via invoice_guid + entry_guid,
 * with an optional reversing-COGS posting (debit asset / credit COGS).
 * Rejects returns exceeding the net fulfilled quantity per entry.
 */
export async function returnToStock(input: FulfillInput): Promise<FulfillResult> {
  await ensureInventoryTables();
  const date = parseMovementDate(input.date);

  let result: FulfillResult | null = null;
  await prisma.$transaction(async (tx) => {
    const invoice = await loadPostedCustomerInvoice(tx, input.invoiceGuid);
    const fulfilledByEntry = await getFulfilledByEntry(tx, input.invoiceGuid);
    validateReturnAllocations(input.allocations, fulfilledByEntry);

    const items = await lockItems(tx, input.bookGuid, input.allocations.map((a) => a.itemId));
    for (const a of input.allocations) await assertLocation(tx, input.bookGuid, a.locationId);

    const reference = `Invoice ${invoice.id} return`;
    const movements: InventoryMovement[] = [];
    for (const a of input.allocations) {
      const item = items.get(a.itemId)!;
      const txnGuid = await maybePostReturn(tx, item, a.quantity, date, input.post, reference);
      movements.push(
        await insertMovement(tx, {
          itemId: item.id,
          locationId: a.locationId,
          movementType: 'return_in',
          quantity: a.quantity,
          unitCost: item.avgCost,
          movementDate: date,
          reference,
          invoiceGuid: input.invoiceGuid,
          entryGuid: a.entryGuid,
          txnGuid,
        }),
      );
    }
    result = { invoiceGuid: input.invoiceGuid, movements };
  });
  return result!;
}

export interface InvoiceFulfillmentEntry {
  entryGuid: string;
  /** Quantity on the invoice entry. */
  invoicedQuantity: number;
  /** Net fulfilled = shipped − returned. */
  fulfilledQuantity: number;
  remainingQuantity: number;
  movements: InventoryMovement[];
}

export interface InvoiceFulfillmentView {
  invoiceGuid: string;
  invoiceId: string;
  entries: InvoiceFulfillmentEntry[];
  fullyFulfilled: boolean;
}

/** Per-entry fulfillment state (movements linked via invoice_guid + entry_guid). */
export async function getInvoiceFulfillment(
  bookGuid: string,
  invoiceGuid: string,
): Promise<InvoiceFulfillmentView> {
  await ensureInventoryTables();

  const invoice = await prisma.invoices.findUnique({ where: { guid: invoiceGuid } });
  if (!invoice) throw new InventoryNotFoundError(`Invoice not found: ${invoiceGuid}`);

  const entryRows: Array<{ guid: string; quantity_num: bigint | null; quantity_denom: bigint | null }> =
    await prisma.entries.findMany({
      where: { invoice: invoiceGuid },
      select: { guid: true, quantity_num: true, quantity_denom: true },
    });

  const movementRows = await prisma.$queryRawUnsafe<Parameters<typeof mapMovementRow>[0][]>(
    `
      SELECT mv.id, mv.item_id, mv.location_id, mv.movement_type, mv.quantity,
             mv.unit_cost, mv.movement_date, mv.reference, mv.invoice_guid,
             mv.entry_guid, mv.txn_guid, mv.counterpart_movement_id, mv.created_at
      FROM gnucash_web_inventory_movements mv
      JOIN gnucash_web_inventory_items i ON i.id = mv.item_id
      WHERE mv.invoice_guid = $1 AND i.book_guid = $2
      ORDER BY mv.id ASC
    `,
    invoiceGuid,
    bookGuid,
  );
  const movements = movementRows.map(mapMovementRow);
  const movementsByEntry = new Map<string, InventoryMovement[]>();
  for (const m of movements) {
    if (!m.entryGuid) continue;
    const arr = movementsByEntry.get(m.entryGuid) ?? [];
    arr.push(m);
    movementsByEntry.set(m.entryGuid, arr);
  }

  const entries: InvoiceFulfillmentEntry[] = entryRows.map((row) => {
    const invoicedQuantity = toDecimalNumber(row.quantity_num, row.quantity_denom);
    const entryMovements = movementsByEntry.get(row.guid) ?? [];
    const fulfilledQuantity = -entryMovements
      .filter((m) => m.movementType === 'ship' || m.movementType === 'return_in')
      .reduce((sum, m) => sum + m.quantity, 0);
    return {
      entryGuid: row.guid,
      invoicedQuantity,
      fulfilledQuantity,
      remainingQuantity: invoicedQuantity - fulfilledQuantity,
      movements: entryMovements,
    };
  });

  return {
    invoiceGuid,
    invoiceId: invoice.id,
    entries,
    fullyFulfilled: entries.length > 0 && entries.every((e) => e.remainingQuantity <= EPSILON),
  };
}
