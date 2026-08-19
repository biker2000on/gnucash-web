/**
 * Inventory Engine tests — pure valuation/stock math (DB-free).
 *
 * Covers: moving-average cost sequences, negative-stock rejection,
 * signed-quantity/type enforcement, transfer pairing, assembly costing,
 * and fulfillment/return allocation validation.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';

// The engine module imports prisma at module scope; stub it so tests never
// touch a database (only pure exports are exercised here).
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    $executeRawUnsafe: vi.fn(),
  },
}));
vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/services/period-lock.service', () => ({
  assertAccountNotLocked: vi.fn().mockResolvedValue(undefined),
  PeriodLockedError: class PeriodLockedError extends Error {},
  periodLockedResponse: vi.fn(),
}));
// Fulfillment resolves invoice→book ownership through its own prisma client.
vi.mock('@/lib/business/entity-ownership', () => ({
  isEntityOwnedByBook: vi.fn().mockResolvedValue(true),
}));

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
  assertPostableAccount,
  receiveStock,
  shouldPostCogs,
  fulfillInvoiceLines,
  returnToStock,
  InventoryValidationError,
  InventoryStockError,
  type AssemblyComponentSpec,
  type FulfillmentAllocation,
  type FifoLayer,
} from '../inventory-engine';
import type { MovementType } from '../services/inventory.service';
import { mapInventoryError } from '../inventory-api-errors';

// ---------------------------------------------------------------------------
// Ledger posting account guards
// ---------------------------------------------------------------------------

describe('assertPostableAccount', () => {
  const postableAccount = (bookGuid: string, placeholder: number | null = 0) => ({
    guid: 'account-guid',
    placeholder,
    book_guid: bookGuid,
  });

  const transactionFor = (account: ReturnType<typeof postableAccount>) =>
    ({ $queryRaw: vi.fn().mockResolvedValue([account]) }) as unknown as Parameters<typeof assertPostableAccount>[0];

  it('rejects posting to an account owned by another book with an actionable API error', async () => {
    const error = await assertPostableAccount(
      transactionFor(postableAccount('other-book')),
      'account-guid',
      'Offset',
      'requested-book',
    ).catch(error => error);

    expect(error).toBeInstanceOf(InventoryValidationError);
    expect((error as Error).message).toBe(
      'Offset account account-guid belongs to book other-book, not requested book requested-book',
    );

    const response = mapInventoryError(error);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: (error as Error).message });
  });

  it('allows posting to an account owned by the requested book', async () => {
    await expect(
      assertPostableAccount(transactionFor(postableAccount('requested-book')), 'account-guid', 'Asset', 'requested-book'),
    ).resolves.toBeUndefined();
  });

  it('still rejects placeholder accounts in the requested book', async () => {
    await expect(
      assertPostableAccount(transactionFor(postableAccount('requested-book', 1)), 'account-guid', 'Asset', 'requested-book'),
    ).rejects.toThrow('Asset account account-guid is a placeholder');
  });
});

describe('receiveStock ledger posting book guard', () => {
  const itemRow = {
    id: 1,
    book_guid: 'active-book',
    sku: 'WIDGET',
    name: 'Widget',
    description: null,
    unit: 'each',
    sale_price: null,
    income_account_guid: null,
    cogs_account_guid: null,
    asset_account_guid: 'asset-account',
    post_to_ledger: true,
    avg_cost: 0,
    valuation_method: 'average',
    reorder_point: null,
    reorder_quantity: null,
    active: true,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };

  function createReceiveTransaction(offsetBookGuid: string) {
    const movementInsert = vi.fn().mockResolvedValue([{
      id: 1,
      item_id: 1,
      location_id: 2,
      movement_type: 'receive',
      quantity: 2,
      unit_cost: 3,
      movement_date: new Date('2026-01-02T00:00:00Z'),
      reference: null,
      invoice_guid: null,
      entry_guid: null,
      txn_guid: 'transaction-guid',
      counterpart_movement_id: null,
      created_at: new Date('2026-01-02T00:00:00Z'),
    }]);
    const transaction = {
      // The account guid is the last interpolated value: the query is
      // composed as `${ancestorCte(guid)} SELECT ... WHERE guid = ${guid}`,
      // so the first value is the shared CTE fragment, not a string.
      $queryRaw: vi.fn().mockImplementation(async (_query: TemplateStringsArray, ...values: unknown[]) => {
        const guid = values.filter((v): v is string => typeof v === 'string').pop()!;
        return [{
          guid,
          placeholder: 0,
          book_guid: guid === 'offset-account' ? offsetBookGuid : 'active-book',
        }];
      }),
      $queryRawUnsafe: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes('FROM gnucash_web_inventory_items')) return [itemRow];
        if (query.includes('FROM gnucash_web_inventory_locations')) {
          return [{ id: 2, name: 'Main warehouse', active: true }];
        }
        if (query.includes('SUM(quantity)')) return [{ total: 0 }];
        if (query.includes('INSERT INTO gnucash_web_inventory_movements')) return movementInsert();
        throw new Error(`Unexpected inventory query: ${query}`);
      }),
      $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
      accounts: {
        findUnique: vi.fn().mockResolvedValue({ guid: 'asset-account', commodity_guid: 'usd-guid' }),
      },
      commodities: {
        findUnique: vi.fn().mockResolvedValue({ guid: 'usd-guid', namespace: 'CURRENCY', fraction: 100 }),
        findFirst: vi.fn(),
      },
      transactions: { create: vi.fn().mockResolvedValue({}) },
      slots: { create: vi.fn().mockResolvedValue({}) },
      splits: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as Parameters<typeof assertPostableAccount>[0];
    return { transaction, movementInsert };
  }

  async function postReceive(offsetBookGuid: string) {
    const { transaction, movementInsert } = createReceiveTransaction(offsetBookGuid);
    const transactionRunner = prismaMock.$transaction as unknown as {
      mockImplementation: (implementation: (callback: (tx: unknown) => Promise<unknown>) => Promise<unknown>) => void;
    };
    transactionRunner.mockImplementation(async callback => callback(transaction));
    const result = receiveStock({
      bookGuid: 'active-book',
      itemId: 1,
      locationId: 2,
      quantity: 2,
      unitCost: 3,
      date: '2026-01-02',
      post: true,
      offsetAccountGuid: 'offset-account',
    });
    return { result, transaction, movementInsert };
  }

  beforeEach(() => {
    prismaMock.$transaction.mockReset();
    prismaMock.$executeRawUnsafe.mockReset();
  });

  it('rejects a foreign offset before any ledger or movement write', async () => {
    const { result, transaction, movementInsert } = await postReceive('foreign-book');

    await expect(result).rejects.toThrow(
      'Offset account offset-account belongs to book foreign-book, not requested book active-book',
    );
    expect(transaction.transactions.create).not.toHaveBeenCalled();
    expect(transaction.splits.create).not.toHaveBeenCalled();
    expect(movementInsert).not.toHaveBeenCalled();
  });

  it('posts through receiveStock when the offset account belongs to the active book', async () => {
    const { result, transaction, movementInsert } = await postReceive('active-book');

    await expect(result).resolves.toMatchObject({ txnGuid: expect.any(String) });
    expect(transaction.transactions.create).toHaveBeenCalledOnce();
    expect(transaction.splits.create).toHaveBeenCalledTimes(2);
    expect(movementInsert).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// COGS posts by DEFAULT on fulfillment
//
// Relieving inventory without recognizing COGS overstates both inventory value
// and gross profit, so an omitted `post` flag must still produce the complete
// double entry. Opting out has to be explicit.
// ---------------------------------------------------------------------------

describe('shouldPostCogs', () => {
  it('posts when the flag is omitted', () => {
    expect(shouldPostCogs(undefined)).toBe(true);
  });

  it('posts when the flag is explicitly true', () => {
    expect(shouldPostCogs(true)).toBe(true);
  });

  it('skips only on an explicit false', () => {
    expect(shouldPostCogs(false)).toBe(false);
  });
});

describe('invoice fulfillment COGS posting', () => {
  const AVG_COST = 4;
  const SHIP_QTY = 3;
  /** Expected COGS amount: 3 × $4.00 = $12.00 → 1200/100 in GnuCash fractions. */
  const EXPECTED_NUM = 1200n;

  const fulfillmentItemRow = {
    id: 1,
    book_guid: 'active-book',
    sku: 'WIDGET',
    name: 'Widget',
    description: null,
    unit: 'each',
    sale_price: null,
    income_account_guid: 'income-account',
    cogs_account_guid: 'cogs-account',
    asset_account_guid: 'asset-account',
    post_to_ledger: true,
    avg_cost: AVG_COST,
    valuation_method: 'average',
    reorder_point: null,
    reorder_quantity: null,
    active: true,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };

  interface CreatedSplit {
    account_guid: string;
    value_num: bigint;
    value_denom: bigint;
    quantity_num: bigint;
    quantity_denom: bigint;
    memo: string;
  }

  function createFulfillmentTransaction() {
    const splitsCreated: CreatedSplit[] = [];
    /** txn_guid stamped on each inserted movement (null = no ledger posting). */
    const movementTxnGuids: Array<string | null> = [];
    /** Cost basis stamped on each inserted movement. */
    const movementUnitCosts: Array<number | null> = [];
    let nextMovementId = 1;
    let currentAvgCost = AVG_COST;

    const transaction = {
      $queryRaw: vi.fn().mockImplementation(async (_query: TemplateStringsArray, ...values: unknown[]) => [
        {
          guid: values.filter((v): v is string => typeof v === 'string').pop()!,
          placeholder: 0,
          book_guid: 'active-book',
        },
      ]),
      $queryRawUnsafe: vi.fn().mockImplementation(async (query: string, ...args: unknown[]) => {
        if (query.includes('INSERT INTO gnucash_web_inventory_movements')) {
          const txnGuid = (args[9] ?? null) as string | null;
          movementTxnGuids.push(txnGuid);
          movementUnitCosts.push((args[4] ?? null) as number | null);
          return [{
            id: nextMovementId++,
            item_id: args[0],
            location_id: args[1],
            movement_type: args[2],
            quantity: args[3],
            unit_cost: args[4],
            movement_date: new Date('2026-02-01T00:00:00Z'),
            reference: args[6],
            invoice_guid: args[7],
            entry_guid: args[8],
            txn_guid: txnGuid,
            counterpart_movement_id: null,
            created_at: new Date('2026-02-01T00:00:00Z'),
          }];
        }
        if (query.includes('FROM gnucash_web_inventory_items')) {
          return [{ ...fulfillmentItemRow, avg_cost: currentAvgCost }];
        }
        if (query.includes('FROM gnucash_web_inventory_locations')) {
          return [{ id: 2, name: 'Main warehouse', active: true }];
        }
        // Net-fulfilled-per-entry lookup: nothing shipped against this invoice yet.
        if (query.includes('GROUP BY entry_guid')) return [];
        // On-hand: plenty of stock at the location.
        if (query.includes('SUM(quantity)')) return [{ total: 100 }];
        throw new Error(`Unexpected inventory query: ${query}`);
      }),
      $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
      invoices: {
        findUnique: vi.fn().mockResolvedValue({
          guid: 'invoice-guid',
          id: 'INV-001',
          owner_type: 2,
          owner_guid: 'customer-guid',
          post_txn: 'invoice-post-txn',
        }),
      },
      jobs: { findUnique: vi.fn() },
      entries: {
        findMany: vi.fn().mockResolvedValue([
          { guid: 'entry-guid', quantity_num: 10n, quantity_denom: 1n },
        ]),
      },
      accounts: {
        findUnique: vi.fn().mockResolvedValue({ guid: 'cogs-account', commodity_guid: 'usd-guid' }),
      },
      commodities: {
        findUnique: vi.fn().mockResolvedValue({ guid: 'usd-guid', namespace: 'CURRENCY', fraction: 100 }),
        findFirst: vi.fn(),
      },
      transactions: { create: vi.fn().mockResolvedValue({}) },
      slots: { create: vi.fn().mockResolvedValue({}) },
      splits: {
        create: vi.fn().mockImplementation(async ({ data }: { data: CreatedSplit }) => {
          splitsCreated.push(data);
          return {};
        }),
      },
    } as unknown as Parameters<typeof assertPostableAccount>[0];

    const transactionRunner = prismaMock.$transaction as unknown as {
      mockImplementation: (implementation: (callback: (tx: unknown) => Promise<unknown>) => Promise<unknown>) => void;
    };
    transactionRunner.mockImplementation(async callback => callback(transaction));
    return {
      transaction,
      splitsCreated,
      movementTxnGuids,
      movementUnitCosts,
      setCurrentAvgCost: (value: number) => { currentAvgCost = value; },
    };
  }

  const fulfillInput = (post?: boolean) => ({
    bookGuid: 'active-book',
    invoiceGuid: 'invoice-guid',
    allocations: [{ entryGuid: 'entry-guid', itemId: 1, quantity: SHIP_QTY, locationId: 2 }],
    date: '2026-02-01',
    ...(post === undefined ? {} : { post }),
  });

  beforeEach(() => {
    prismaMock.$transaction.mockReset();
    prismaMock.$executeRawUnsafe.mockReset();
  });

  it('posts COGS when no post option is supplied', async () => {
    const { transaction, splitsCreated, movementTxnGuids } = createFulfillmentTransaction();

    const result = await fulfillInvoiceLines(fulfillInput());

    expect(transaction.transactions.create).toHaveBeenCalledOnce();
    expect(splitsCreated).toHaveLength(2);
    expect(result.movements).toHaveLength(1);
    // The movement is linked to the ledger transaction that was just written.
    expect(movementTxnGuids[0]).toEqual(expect.any(String));
    expect(result.movements[0].txnGuid).toBe(movementTxnGuids[0]);
  });

  it('debits COGS and credits the inventory asset at quantity × avg cost', async () => {
    const { splitsCreated } = createFulfillmentTransaction();

    await fulfillInvoiceLines(fulfillInput());

    const cogsSplit = splitsCreated.find(s => s.account_guid === 'cogs-account');
    const assetSplit = splitsCreated.find(s => s.account_guid === 'asset-account');
    expect(cogsSplit?.value_num).toBe(EXPECTED_NUM);
    expect(cogsSplit?.value_denom).toBe(100n);
    expect(assetSplit?.value_num).toBe(-EXPECTED_NUM);
  });

  it('writes a balanced entry (splits sum to zero, quantity mirrors value)', async () => {
    const { splitsCreated } = createFulfillmentTransaction();

    await fulfillInvoiceLines(fulfillInput());

    const denominators = new Set(splitsCreated.map(s => s.value_denom));
    expect(denominators.size).toBe(1);
    const total = splitsCreated.reduce((sum, s) => sum + s.value_num, 0n);
    expect(total).toBe(0n);
    for (const split of splitsCreated) {
      expect(split.quantity_num).toBe(split.value_num);
      expect(split.quantity_denom).toBe(split.value_denom);
    }
  });

  it('skips the COGS posting only when the caller opts out with post: false', async () => {
    const { transaction, splitsCreated, movementTxnGuids } = createFulfillmentTransaction();

    const result = await fulfillInvoiceLines(fulfillInput(false));

    expect(transaction.transactions.create).not.toHaveBeenCalled();
    expect(splitsCreated).toHaveLength(0);
    // Stock still moves — only the ledger side is suppressed.
    expect(result.movements).toHaveLength(1);
    expect(movementTxnGuids[0]).toBeNull();
    expect(result.movements[0].txnGuid).toBeNull();
  });

  it('names every unpostable item at once instead of failing one retry at a time', async () => {
    const { transaction } = createFulfillmentTransaction();
    // Two more allocated items, both missing their COGS/asset accounts.
    const previous = transaction.$queryRawUnsafe as unknown as (query: string, ...args: unknown[]) => Promise<unknown>;
    (transaction as unknown as { $queryRawUnsafe: unknown }).$queryRawUnsafe = vi.fn().mockImplementation(
      async (query: string, ...args: unknown[]) => {
        if (query.includes('FROM gnucash_web_inventory_items')) {
          return [
            fulfillmentItemRow,
            { ...fulfillmentItemRow, id: 2, sku: 'GADGET', cogs_account_guid: null },
            { ...fulfillmentItemRow, id: 3, sku: 'DOODAD', asset_account_guid: null },
          ];
        }
        return previous(query, ...args);
      },
    );

    const fulfillError = await fulfillInvoiceLines({
      ...fulfillInput(),
      allocations: [1, 2, 3].map(itemId => ({
        entryGuid: 'entry-guid', itemId, quantity: 1, locationId: 2,
      })),
    }).catch(e => e);

    expect(fulfillError).toBeInstanceOf(InventoryValidationError);
    expect((fulfillError as Error).message).toContain('DOODAD');
    expect((fulfillError as Error).message).toContain('GADGET');
    // The correctly-configured item is not blamed.
    expect((fulfillError as Error).message).not.toContain('WIDGET');
    expect(transaction.transactions.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Returns remain OPT-IN, but reverse at the fulfillment line's recorded
  // weighted shipment basis rather than the item's current moving average.
  // -------------------------------------------------------------------------

  /** Report 5 net-fulfilled units so a return is within bounds. */
  function withFulfilledHistory(
    transaction: ReturnType<typeof createFulfillmentTransaction>['transaction'],
    { fulfilled = 5, shipmentQuantity = 5, totalCost = 20, missingCostCount = 0 } = {},
  ) {
    const previous = transaction.$queryRawUnsafe as unknown as (query: string, ...args: unknown[]) => Promise<unknown>;
    (transaction as unknown as { $queryRawUnsafe: unknown }).$queryRawUnsafe = vi.fn().mockImplementation(
      async (query: string, ...args: unknown[]) => {
        if (query.includes('GROUP BY entry_guid')) return [{ entry_guid: 'entry-guid', total: -fulfilled }];
        if (query.includes('shipment_quantity')) {
          return [{
            shipment_quantity: shipmentQuantity,
            total_cost: totalCost,
            missing_cost_count: missingCostCount,
          }];
        }
        return previous(query, ...args);
      },
    );
  }

  it('does NOT post a reversal on returnToStock without an explicit post option', async () => {
    const { transaction, splitsCreated, movementTxnGuids } = createFulfillmentTransaction();
    withFulfilledHistory(transaction);

    const result = await returnToStock(fulfillInput());

    expect(transaction.transactions.create).not.toHaveBeenCalled();
    expect(splitsCreated).toHaveLength(0);
    // Stock still comes back; only the ledger reversal is withheld.
    expect(result.movements).toHaveLength(1);
    expect(movementTxnGuids[0]).toBeNull();
  });

  it('posts the reversal on returnToStock when the caller opts in with post: true', async () => {
    const { transaction, splitsCreated } = createFulfillmentTransaction();
    withFulfilledHistory(transaction);

    await returnToStock(fulfillInput(true));

    expect(transaction.transactions.create).toHaveBeenCalledOnce();
    expect(splitsCreated).toHaveLength(2);
    // Reversal direction: asset debited, COGS credited.
    expect(splitsCreated.find(s => s.account_guid === 'asset-account')?.value_num).toBe(EXPECTED_NUM);
    expect(splitsCreated.find(s => s.account_guid === 'cogs-account')?.value_num).toBe(-EXPECTED_NUM);
    expect(splitsCreated.reduce((sum, s) => sum + s.value_num, 0n)).toBe(0n);
  });

  it('nets the $10 shipment / $20 current-average return exactly to zero in COGS and inventory', async () => {
    const { transaction, splitsCreated, movementUnitCosts, setCurrentAvgCost } = createFulfillmentTransaction();
    setCurrentAvgCost(10);
    withFulfilledHistory(transaction, { fulfilled: SHIP_QTY, shipmentQuantity: SHIP_QTY, totalCost: 30 });

    await fulfillInvoiceLines(fulfillInput());
    // Later receipts moved the current average, but not this fulfillment line's basis.
    setCurrentAvgCost(20);
    await returnToStock(fulfillInput(true));

    expect(movementUnitCosts).toEqual([10, 10]);
    expect(splitsCreated.filter(s => s.account_guid === 'cogs-account')
      .reduce((sum, s) => sum + s.value_num, 0n)).toBe(0n);
    expect(splitsCreated.filter(s => s.account_guid === 'asset-account')
      .reduce((sum, s) => sum + s.value_num, 0n)).toBe(0n);
  });

  it('uses the line shipment weighted average for a partial return', async () => {
    const { transaction, splitsCreated, movementUnitCosts } = createFulfillmentTransaction();
    // Five units shipped at $10 and five at $20 => $15 weighted basis.
    withFulfilledHistory(transaction, { fulfilled: 10, shipmentQuantity: 10, totalCost: 150 });

    await returnToStock({ ...fulfillInput(true), allocations: [{
      entryGuid: 'entry-guid', itemId: 1, quantity: 2, locationId: 2,
    }] });

    expect(movementUnitCosts).toEqual([15]);
    expect(splitsCreated.find(s => s.account_guid === 'asset-account')?.value_num).toBe(3000n);
    expect(splitsCreated.find(s => s.account_guid === 'cogs-account')?.value_num).toBe(-3000n);
    // return_in is cost-bearing: re-entry at $15 moves the $4 running average.
    expect(transaction.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('SET avg_cost'), 1, (100 * AVG_COST + 2 * 15) / 102,
    );
  });

  it('preserves legacy data-only returns without shipment cost', async () => {
    const { transaction, movementUnitCosts } = createFulfillmentTransaction();
    withFulfilledHistory(transaction, { missingCostCount: 1, totalCost: 0 });

    const legacyReturn = await returnToStock(fulfillInput(false));
    expect(legacyReturn.movements[0].unitCost).toBe(AVG_COST);
    expect(movementUnitCosts).toEqual([AVG_COST]);
    expect(transaction.transactions.create).not.toHaveBeenCalled();
    expect(legacyReturn.warnings).toEqual([]);
  });

  /**
   * A legacy shipment with NO recorded unit_cost used to make the whole return
   * un-postable ("Shipment cost is not recorded ... turn COGS posting off"),
   * leaving the user to reverse COGS by hand outside the app. db-init's
   * one-time backfill reconstructs the cost where it can; where it cannot, the
   * reversal now posts at the item's CURRENT weighted cost — the same cost the
   * stock re-enters at, so asset and on-hand valuation stay consistent — and
   * says so in warnings and in the ledger memo.
   */
  it('posts the reversal at the current cost, with a warning, when no shipment cost exists', async () => {
    const { transaction, splitsCreated, movementUnitCosts } = createFulfillmentTransaction();
    withFulfilledHistory(transaction, { missingCostCount: 1, totalCost: 0 });

    const result = await returnToStock(fulfillInput(true));

    expect(transaction.transactions.create).toHaveBeenCalledOnce();
    expect(movementUnitCosts).toEqual([AVG_COST]);
    // Reversal at the item's current cost, in the reversing direction.
    expect(splitsCreated.find(s => s.account_guid === 'asset-account')?.value_num).toBe(EXPECTED_NUM);
    expect(splitsCreated.find(s => s.account_guid === 'cogs-account')?.value_num).toBe(-EXPECTED_NUM);
    // The estimate is reported, not silent...
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('WIDGET');
    expect(result.warnings[0]).toMatch(/no shipment cost/i);
    // ...and carried into the ledger itself.
    for (const split of splitsCreated) {
      expect(split.memo).toContain('estimated basis');
    }
  });

  it('leaves the warning list empty when the shipment basis IS recorded', async () => {
    const { transaction, splitsCreated } = createFulfillmentTransaction();
    withFulfilledHistory(transaction);

    const result = await returnToStock(fulfillInput(true));

    expect(result.warnings).toEqual([]);
    for (const split of splitsCreated) {
      expect(split.memo).not.toContain('estimated basis');
    }
  });

  it('does not leave a residual when three units share a $10 shipment total', async () => {
    const { transaction, splitsCreated, movementUnitCosts, setCurrentAvgCost } = createFulfillmentTransaction();
    const repeatingBasis = 10 / 3;
    setCurrentAvgCost(repeatingBasis);
    withFulfilledHistory(transaction, { fulfilled: 3, shipmentQuantity: 3, totalCost: 10 });
    const threeUnitInput = {
      ...fulfillInput(true),
      allocations: [{ entryGuid: 'entry-guid', itemId: 1, quantity: 3, locationId: 2 }],
    };

    await fulfillInvoiceLines(threeUnitInput);
    setCurrentAvgCost(20);
    await returnToStock(threeUnitInput);

    expect(movementUnitCosts).toEqual([repeatingBasis, repeatingBasis]);
    expect(splitsCreated.filter(s => s.account_guid === 'cogs-account')
      .reduce((sum, s) => sum + s.value_num, 0n)).toBe(0n);
    expect(splitsCreated.filter(s => s.account_guid === 'asset-account')
      .reduce((sum, s) => sum + s.value_num, 0n)).toBe(0n);
  });

  it('refuses a return that exceeds the line quantity still fulfilled', async () => {
    const { transaction } = createFulfillmentTransaction();
    withFulfilledHistory(transaction, { fulfilled: 2 });

    await expect(returnToStock(fulfillInput(true))).rejects.toThrow(
      /returning 3 exceeds the fulfilled quantity 2/,
    );
    expect(transaction.transactions.create).not.toHaveBeenCalled();
  });
});

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
