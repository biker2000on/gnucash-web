/**
 * Lot Scrub Engine Tests
 *
 * Comprehensive tests covering:
 * A: splitSellAcrossLots
 * B: linkTransferToLot
 * C: generateCapitalGains
 * + classifyAccountTax and classifyHoldingPeriod helpers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockSplitsFindUnique = vi.fn();
const mockSplitsFindMany = vi.fn();
const mockSplitsCreate = vi.fn();
const mockSplitsUpdate = vi.fn();
const mockLotsFindUnique = vi.fn();
const mockLotsCreate = vi.fn();
const mockLotsUpdate = vi.fn();
const mockSlotsFindFirst = vi.fn();
const mockSlotsFindMany = vi.fn();
const mockSlotsCreate = vi.fn();
const mockAccountsFindUnique = vi.fn();
const mockAccountsFindFirst = vi.fn();
const mockAccountsFindMany = vi.fn();
const mockAccountsCreate = vi.fn();
const mockBooksFindFirst = vi.fn();
const mockTransactionsCreate = vi.fn();
const mockCommoditiesFindUnique = vi.fn();
const mockCommoditiesFindMany = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    splits: {
      findUnique: (...args: unknown[]) => mockSplitsFindUnique(...args),
      findMany: (...args: unknown[]) => mockSplitsFindMany(...args),
      create: (...args: unknown[]) => mockSplitsCreate(...args),
      update: (...args: unknown[]) => mockSplitsUpdate(...args),
    },
    lots: {
      findUnique: (...args: unknown[]) => mockLotsFindUnique(...args),
      create: (...args: unknown[]) => mockLotsCreate(...args),
      update: (...args: unknown[]) => mockLotsUpdate(...args),
    },
    slots: {
      findFirst: (...args: unknown[]) => mockSlotsFindFirst(...args),
      findMany: (...args: unknown[]) => mockSlotsFindMany(...args),
      create: (...args: unknown[]) => mockSlotsCreate(...args),
    },
    accounts: {
      findUnique: (...args: unknown[]) => mockAccountsFindUnique(...args),
      findFirst: (...args: unknown[]) => mockAccountsFindFirst(...args),
      findMany: (...args: unknown[]) => mockAccountsFindMany(...args),
      create: (...args: unknown[]) => mockAccountsCreate(...args),
    },
    books: {
      findFirst: (...args: unknown[]) => mockBooksFindFirst(...args),
    },
    transactions: {
      create: (...args: unknown[]) => mockTransactionsCreate(...args),
    },
    commodities: {
      findUnique: (...args: unknown[]) => mockCommoditiesFindUnique(...args),
      findMany: (...args: unknown[]) => mockCommoditiesFindMany(...args),
    },
  },
}));

// Use the same mock for the tx parameter
function createMockTx() {
  return {
    splits: {
      findUnique: mockSplitsFindUnique,
      findMany: mockSplitsFindMany,
      create: mockSplitsCreate,
      update: mockSplitsUpdate,
    },
    lots: {
      findUnique: mockLotsFindUnique,
      create: mockLotsCreate,
      update: mockLotsUpdate,
    },
    slots: {
      findFirst: mockSlotsFindFirst,
      findMany: mockSlotsFindMany,
      create: mockSlotsCreate,
    },
    accounts: {
      findUnique: mockAccountsFindUnique,
      findFirst: mockAccountsFindFirst,
      findMany: mockAccountsFindMany,
      create: mockAccountsCreate,
    },
    books: {
      findFirst: mockBooksFindFirst,
    },
    transactions: {
      create: mockTransactionsCreate,
    },
    commodities: {
      findUnique: mockCommoditiesFindUnique,
      findMany: mockCommoditiesFindMany,
    },
  } as never;
}

import {
  splitSellAcrossLots,
  linkTransferToLot,
  splitTransferAcrossSourceLots,
  generateCapitalGains,
  classifyAccountTax,
  classifyHoldingPeriod,
  type OpenLot,
} from '../lot-scrub';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

// Native GnuCash sign convention: a sell credits the stock account, so the
// stock split has NEGATIVE quantity and NEGATIVE value; the cash side is positive.
function makeSplit(overrides: Record<string, unknown> = {}) {
  return {
    guid: 'sell-split-guid-00000000000000',
    tx_guid: 'tx-guid-000000000000000000000',
    account_guid: 'acct-guid-0000000000000000000',
    memo: '',
    action: '',
    reconcile_state: 'n',
    reconcile_date: null,
    value_num: -10000n,  // -$100 (sell credit)
    value_denom: 100n,
    quantity_num: -100n, // -1 share
    quantity_denom: 100n,
    lot_guid: null,
    ...overrides,
  };
}

function makeOpenLot(guid: string, shares: number, openDate?: Date): OpenLot {
  return {
    guid,
    shares,
    openDate: openDate || new Date('2024-01-01'),
  };
}

// ---------------------------------------------------------------------------
// A: splitSellAcrossLots
// ---------------------------------------------------------------------------

describe('splitSellAcrossLots', () => {
  const tx = createMockTx();
  const runId = 'run-001';

  it('A1: Sell fits in one lot — assign original split, no sub-splits', async () => {
    const sellSplit = makeSplit({
      quantity_num: -100n, // -1 share
      quantity_denom: 100n,
      value_num: -15000n,  // -$150 (credit)
      value_denom: 100n,
    });
    mockSplitsFindUnique.mockResolvedValue(sellSplit);

    const lots = [makeOpenLot('lot-a-guid-00000000000000000', 1.5)];
    const result = await splitSellAcrossLots(sellSplit.guid, lots, runId, tx);

    expect(result.subSplitsCreated).toEqual([]);
    expect(result.lotsUsed).toEqual(['lot-a-guid-00000000000000000']);
    expect(result.warning).toBeUndefined();
    // Original split assigned to lot
    expect(mockSplitsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { guid: sellSplit.guid },
        data: { lot_guid: 'lot-a-guid-00000000000000000' },
      }),
    );
    // Lot shares mutated in-place
    expect(lots[0].shares).toBeCloseTo(0.5);
  });

  it('A2: Sell spans 2 lots — create 1 sub-split', async () => {
    const sellSplit = makeSplit({
      quantity_num: -300n, // -3 shares
      quantity_denom: 100n,
      value_num: -45000n,  // -$450 (credit)
      value_denom: 100n,
    });
    mockSplitsFindUnique.mockResolvedValue(sellSplit);
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockSplitsUpdate.mockResolvedValue({});
    // Transaction balance check — return splits that sum to zero
    mockSplitsFindMany.mockResolvedValue([
      { value_num: -22500n, value_denom: 100n }, // first alloc: 1.5 shares * $150 = -$225
      { value_num: -22500n, value_denom: 100n }, // sub-split: 1.5 shares * $150 = -$225
      { value_num: 45000n, value_denom: 100n },  // cash side (debit)
    ]);

    const lots = [
      makeOpenLot('lot-a-guid-00000000000000000', 1.5),
      makeOpenLot('lot-b-guid-00000000000000000', 2.0),
    ];

    const result = await splitSellAcrossLots(sellSplit.guid, lots, runId, tx);

    expect(result.subSplitsCreated).toHaveLength(1);
    expect(result.lotsUsed).toEqual([
      'lot-a-guid-00000000000000000',
      'lot-b-guid-00000000000000000',
    ]);
    expect(result.warning).toBeUndefined();
    // Original split updated for first lot
    expect(mockSplitsUpdate).toHaveBeenCalled();
    // Sub-split created for second lot with native signs
    // (negative quantity AND negative value — a credit on the stock account)
    expect(mockSplitsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tx_guid: sellSplit.tx_guid,
          account_guid: sellSplit.account_guid,
          lot_guid: 'lot-b-guid-00000000000000000',
          quantity_num: -150n,   // -1.5 shares
          value_num: -22500n,    // -$225 (remainder of -$450)
        }),
      }),
    );
    // Original values saved as slots
    expect(mockSlotsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          obj_guid: sellSplit.guid,
          name: 'original_quantity_num',
        }),
      }),
    );
    // Lot shares mutated
    expect(lots[0].shares).toBeCloseTo(0);
    expect(lots[1].shares).toBeCloseTo(0.5);
  });

  it('A3: Sell spans 3+ lots — create N-1 sub-splits', async () => {
    const sellSplit = makeSplit({
      quantity_num: -500n, // -5 shares
      quantity_denom: 100n,
      value_num: -50000n,
      value_denom: 100n,
    });
    mockSplitsFindUnique.mockResolvedValue(sellSplit);
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockSplitsUpdate.mockResolvedValue({});
    // Balance check
    mockSplitsFindMany.mockResolvedValue([
      { value_num: 0n, value_denom: 100n },
    ]);

    const lots = [
      makeOpenLot('lot-1-guid-00000000000000000', 2.0),
      makeOpenLot('lot-2-guid-00000000000000000', 2.0),
      makeOpenLot('lot-3-guid-00000000000000000', 2.0),
    ];

    const result = await splitSellAcrossLots(sellSplit.guid, lots, runId, tx);

    // 3 lots used, 2 sub-splits created (original goes to lot-1)
    expect(result.subSplitsCreated).toHaveLength(2);
    expect(result.lotsUsed).toHaveLength(3);
    expect(lots[0].shares).toBeCloseTo(0);
    expect(lots[1].shares).toBeCloseTo(0);
    expect(lots[2].shares).toBeCloseTo(1);
  });

  it('A4: Sell exceeds all lots — warning', async () => {
    const sellSplit = makeSplit({
      quantity_num: -1000n, // -10 shares
      quantity_denom: 100n,
      value_num: -100000n,
      value_denom: 100n,
    });
    mockSplitsFindUnique.mockResolvedValue(sellSplit);
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockSplitsUpdate.mockResolvedValue({});
    mockSplitsFindMany.mockResolvedValue([{ value_num: 0n, value_denom: 100n }]);

    const lots = [
      makeOpenLot('lot-a-guid-00000000000000000', 2.0),
      makeOpenLot('lot-b-guid-00000000000000000', 3.0),
    ];

    const result = await splitSellAcrossLots(sellSplit.guid, lots, runId, tx);

    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('exceeds');
  });

  it('A5: No open lots — warning', async () => {
    const sellSplit = makeSplit();
    mockSplitsFindUnique.mockResolvedValue(sellSplit);

    const lots: OpenLot[] = [];
    const result = await splitSellAcrossLots(sellSplit.guid, lots, runId, tx);

    expect(result.warning).toBe('No open lots available');
    expect(result.subSplitsCreated).toEqual([]);
  });

  it('A6: Transaction balance invariant — throws on imbalance', async () => {
    const sellSplit = makeSplit({
      quantity_num: -300n,
      quantity_denom: 100n,
      value_num: -30000n,
      value_denom: 100n,
    });
    mockSplitsFindUnique.mockResolvedValue(sellSplit);
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockSplitsUpdate.mockResolvedValue({});
    // Return imbalanced transaction
    mockSplitsFindMany.mockResolvedValue([
      { value_num: -15000n, value_denom: 100n },
      { value_num: -15000n, value_denom: 100n },
      { value_num: 20000n, value_denom: 100n }, // $100 imbalance
    ]);

    const lots = [
      makeOpenLot('lot-a-guid-00000000000000000', 1.0),
      makeOpenLot('lot-b-guid-00000000000000000', 2.0),
    ];

    await expect(
      splitSellAcrossLots(sellSplit.guid, lots, runId, tx),
    ).rejects.toThrow('Transaction balance invariant violated');
  });
});

// ---------------------------------------------------------------------------
// B: linkTransferToLot
// ---------------------------------------------------------------------------

describe('linkTransferToLot', () => {
  const tx = createMockTx();
  const runId = 'run-002';

  it('B1: Transfer with source lot — creates dest lot with metadata', async () => {
    const split = {
      guid: 'xfer-split-guid-000000000000000',
      tx_guid: 'xfer-tx-guid-0000000000000000',
      account_guid: 'dest-acct-guid-00000000000000',
      lot_guid: null,
      quantity_num: 200n,
      quantity_denom: 100n,
      account: { commodity_guid: 'aapl-commodity-guid-0000000000' },
      transaction: {
        post_date: new Date('2024-06-15'),
        splits: [
          {
            guid: 'xfer-split-guid-000000000000000',
            account_guid: 'dest-acct-guid-00000000000000',
            quantity_num: 200n,
            quantity_denom: 100n,
            lot_guid: null,
            account: { guid: 'dest-acct-guid-00000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
          },
          {
            guid: 'src-split-guid-0000000000000000',
            account_guid: 'src-acct-guid-000000000000000',
            quantity_num: -200n,
            quantity_denom: 100n,
            lot_guid: 'src-lot-guid-0000000000000000',
            account: { guid: 'src-acct-guid-000000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
          },
        ],
      },
    };

    mockSplitsFindUnique.mockResolvedValue(split);
    mockLotsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockSplitsUpdate.mockResolvedValue({});
    // acquisition_date slot from source lot
    mockSlotsFindFirst.mockResolvedValue({ string_val: '2023-03-01T00:00:00.000Z' });

    const result = await linkTransferToLot(split.guid, runId, tx);

    expect(result.created).toBe(true);
    expect(result.lotGuid).toBeDefined();
    // Lot created
    expect(mockLotsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          account_guid: 'dest-acct-guid-00000000000000',
          is_closed: 0,
        }),
      }),
    );
    // source_lot_guid slot created
    expect(mockSlotsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'source_lot_guid',
          string_val: 'src-lot-guid-0000000000000000',
        }),
      }),
    );
    // acquisition_date slot
    expect(mockSlotsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'acquisition_date',
          string_val: '2023-03-01T00:00:00.000Z',
        }),
      }),
    );
    // Split updated
    expect(mockSplitsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { guid: split.guid },
        data: expect.objectContaining({ lot_guid: expect.any(String) }),
      }),
    );
  });

  it('B2: Transfer without source lot — dest lot, no acquisition date from slot', async () => {
    const split = {
      guid: 'xfer-split-guid-000000000000000',
      tx_guid: 'xfer-tx-guid-0000000000000000',
      account_guid: 'dest-acct-guid-00000000000000',
      lot_guid: null,
      quantity_num: 100n,
      quantity_denom: 100n,
      account: { commodity_guid: 'aapl-commodity-guid-0000000000' },
      transaction: {
        post_date: new Date('2024-06-15'),
        splits: [
          {
            guid: 'xfer-split-guid-000000000000000',
            account_guid: 'dest-acct-guid-00000000000000',
            quantity_num: 100n,
            quantity_denom: 100n,
            lot_guid: null,
            account: { guid: 'dest-acct-guid-00000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
          },
          {
            guid: 'src-split-guid-0000000000000000',
            account_guid: 'src-acct-guid-000000000000000',
            quantity_num: -100n,
            quantity_denom: 100n,
            lot_guid: null, // No source lot
            account: { guid: 'src-acct-guid-000000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
          },
        ],
      },
    };

    mockSplitsFindUnique.mockResolvedValue(split);
    mockLotsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockSplitsUpdate.mockResolvedValue({});

    const result = await linkTransferToLot(split.guid, runId, tx);

    expect(result.created).toBe(true);
    // No source_lot_guid or acquisition_date slots since no source lot
    const slotCreateCalls = mockSlotsCreate.mock.calls.map(c => (c[0] as { data: { name: string } }).data.name);
    expect(slotCreateCalls).not.toContain('source_lot_guid');
    expect(slotCreateCalls).not.toContain('acquisition_date');
  });

  it('B3: Already-assigned split — idempotency guard returns existing lot', async () => {
    const split = {
      guid: 'xfer-split-guid-000000000000000',
      tx_guid: 'xfer-tx-guid-0000000000000000',
      account_guid: 'dest-acct-guid-00000000000000',
      lot_guid: 'existing-lot-guid-00000000000', // Already assigned!
      quantity_num: 100n,
      quantity_denom: 100n,
      account: { commodity_guid: 'aapl-commodity-guid-0000000000' },
      transaction: { post_date: new Date(), splits: [] },
    };

    mockSplitsFindUnique.mockResolvedValue(split);

    const result = await linkTransferToLot(split.guid, runId, tx);

    expect(result.created).toBe(false);
    expect(result.lotGuid).toBe('existing-lot-guid-00000000000');
    // No lot creation or slot creation
    expect(mockLotsCreate).not.toHaveBeenCalled();
    expect(mockSlotsCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// D: splitTransferAcrossSourceLots
// ---------------------------------------------------------------------------

describe('splitTransferAcrossSourceLots', () => {
  const tx = createMockTx();
  const runId = 'run-004';

  function makeTransferInSplit(overrides: Record<string, unknown> = {}) {
    return {
      guid: 'xfer-in-split-guid-00000000000',
      tx_guid: 'xfer-tx-guid-0000000000000000',
      account_guid: 'dest-acct-guid-00000000000000',
      memo: '',
      action: '',
      reconcile_state: 'n',
      reconcile_date: null,
      lot_guid: null,
      quantity_num: 59100n,
      quantity_denom: 100n,
      value_num: 0n,
      value_denom: 100n,
      account: { commodity_guid: 'aapl-commodity-guid-0000000000' },
      transaction: {
        post_date: new Date('2024-06-15'),
        splits: [],
      },
      ...overrides,
    };
  }

  it('D1: Single source lot — creates one dest lot, no sub-splits', async () => {
    const split = makeTransferInSplit();
    split.transaction.splits = [
      {
        guid: 'xfer-in-split-guid-00000000000',
        account_guid: 'dest-acct-guid-00000000000000',
        quantity_num: 59100n,
        quantity_denom: 100n,
        lot_guid: null,
        account: { guid: 'dest-acct-guid-00000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
      },
      {
        guid: 'src-split-guid-0000000000000000',
        account_guid: 'src-acct-guid-000000000000000',
        quantity_num: -59100n,
        quantity_denom: 100n,
        lot_guid: 'src-lot-a-guid-00000000000000',
        account: { guid: 'src-acct-guid-000000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
      },
    ] as never;

    mockSplitsFindUnique.mockResolvedValue(split);
    mockLotsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockSplitsUpdate.mockResolvedValue({});
    // acquisition_date slot from source lot
    mockSlotsFindFirst.mockResolvedValue({ string_val: '2023-03-01T00:00:00.000Z' });

    const result = await splitTransferAcrossSourceLots(split.guid, runId, tx);

    // Single source lot => delegates to linkTransferToLot => 1 lot, 0 sub-splits
    expect(result.lotsCreated).toBe(1);
    expect(result.subSplitsCreated).toBe(0);
    expect(mockLotsCreate).toHaveBeenCalledTimes(1);
    // source_lot_guid slot created
    expect(mockSlotsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'source_lot_guid',
          string_val: 'src-lot-a-guid-00000000000000',
        }),
      }),
    );
  });

  it('D2: Four source lots — sub-splits transfer-in into 4 dest lots', async () => {
    const split = makeTransferInSplit({
      quantity_num: 59100n,
      quantity_denom: 100n,
      value_num: 0n,
      value_denom: 100n,
    });
    split.transaction.splits = [
      {
        guid: 'xfer-in-split-guid-00000000000',
        account_guid: 'dest-acct-guid-00000000000000',
        quantity_num: 59100n,
        quantity_denom: 100n,
        lot_guid: null,
        account: { guid: 'dest-acct-guid-00000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
      },
      {
        guid: 'src-split-1-guid-000000000000',
        account_guid: 'src-acct-guid-000000000000000',
        quantity_num: -53400n,
        quantity_denom: 100n,
        lot_guid: 'src-lot-1-guid-00000000000000',
        account: { guid: 'src-acct-guid-000000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
      },
      {
        guid: 'src-split-2-guid-000000000000',
        account_guid: 'src-acct-guid-000000000000000',
        quantity_num: -3300n,
        quantity_denom: 100n,
        lot_guid: 'src-lot-2-guid-00000000000000',
        account: { guid: 'src-acct-guid-000000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
      },
      {
        guid: 'src-split-3-guid-000000000000',
        account_guid: 'src-acct-guid-000000000000000',
        quantity_num: -1389n,
        quantity_denom: 100n,
        lot_guid: 'src-lot-3-guid-00000000000000',
        account: { guid: 'src-acct-guid-000000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
      },
      {
        guid: 'src-split-4-guid-000000000000',
        account_guid: 'src-acct-guid-000000000000000',
        quantity_num: -1011n,
        quantity_denom: 100n,
        lot_guid: 'src-lot-4-guid-00000000000000',
        account: { guid: 'src-acct-guid-000000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
      },
    ] as never;

    mockSplitsFindUnique.mockResolvedValue(split);
    mockLotsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockSplitsUpdate.mockResolvedValue({});
    mockSplitsCreate.mockResolvedValue({});
    // Return acquisition dates in order for each source lot
    mockSlotsFindFirst
      .mockResolvedValueOnce({ string_val: '2022-01-15T00:00:00.000Z' }) // lot 1
      .mockResolvedValueOnce({ string_val: '2022-03-01T00:00:00.000Z' }) // lot 2
      .mockResolvedValueOnce({ string_val: '2022-06-01T00:00:00.000Z' }) // lot 3
      .mockResolvedValueOnce({ string_val: '2023-01-01T00:00:00.000Z' }); // lot 4

    const result = await splitTransferAcrossSourceLots(split.guid, runId, tx);

    expect(result.lotsCreated).toBe(4);
    expect(result.subSplitsCreated).toBe(3);

    // 4 source_lot_guid slots created
    const sourceLotSlotCalls = mockSlotsCreate.mock.calls.filter(
      c => (c[0] as { data: { name: string } }).data.name === 'source_lot_guid',
    );
    expect(sourceLotSlotCalls).toHaveLength(4);

    // 4 acquisition_date slots created
    const acqDateSlotCalls = mockSlotsCreate.mock.calls.filter(
      c => (c[0] as { data: { name: string } }).data.name === 'acquisition_date',
    );
    expect(acqDateSlotCalls).toHaveLength(4);

    // Original split updated with first allocation's quantity (534 shares)
    expect(mockSplitsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { guid: split.guid },
        data: expect.objectContaining({
          quantity_num: 53400n,
        }),
      }),
    );

    // 3 sub-splits created
    expect(mockSplitsCreate).toHaveBeenCalledTimes(3);

    // original_quantity_num slot saved for revert
    expect(mockSlotsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          obj_guid: split.guid,
          name: 'original_quantity_num',
          string_val: '59100',
        }),
      }),
    );
  });

  it('D3: Transfer-in already has lot — idempotent', async () => {
    const split = makeTransferInSplit({
      lot_guid: 'existing-lot-guid-00000000000',
    });

    mockSplitsFindUnique.mockResolvedValue(split);

    const result = await splitTransferAcrossSourceLots(split.guid, runId, tx);

    expect(result.lotsCreated).toBe(0);
    expect(result.subSplitsCreated).toBe(0);
    expect(mockLotsCreate).not.toHaveBeenCalled();
  });

  it('D4: Source splits have no lot assignments — single dest lot fallback', async () => {
    const split = makeTransferInSplit({
      quantity_num: 500n,
      quantity_denom: 100n,
      value_num: 0n,
      value_denom: 100n,
    });
    split.transaction.splits = [
      {
        guid: 'xfer-in-split-guid-00000000000',
        account_guid: 'dest-acct-guid-00000000000000',
        quantity_num: 500n,
        quantity_denom: 100n,
        lot_guid: null,
        account: { guid: 'dest-acct-guid-00000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
      },
      {
        guid: 'src-split-guid-0000000000000000',
        account_guid: 'src-acct-guid-000000000000000',
        quantity_num: -500n,
        quantity_denom: 100n,
        lot_guid: null, // No lot assignment
        account: { guid: 'src-acct-guid-000000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
      },
    ] as never;

    mockSplitsFindUnique.mockResolvedValue(split);
    mockLotsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockSplitsUpdate.mockResolvedValue({});

    const result = await splitTransferAcrossSourceLots(split.guid, runId, tx);

    // No lotted source splits => delegates to linkTransferToLot => 1 lot, 0 sub-splits
    expect(result.lotsCreated).toBe(1);
    expect(result.subSplitsCreated).toBe(0);
  });

  it('D5: Two source lots with non-zero transfer value — value split proportionally', async () => {
    const split = makeTransferInSplit({
      quantity_num: 1000n,  // +10 shares
      quantity_denom: 100n,
      value_num: 100000n,   // $1000
      value_denom: 100n,
    });
    split.transaction.splits = [
      {
        guid: 'xfer-in-split-guid-00000000000',
        account_guid: 'dest-acct-guid-00000000000000',
        quantity_num: 1000n,
        quantity_denom: 100n,
        lot_guid: null,
        account: { guid: 'dest-acct-guid-00000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
      },
      {
        guid: 'src-split-1-guid-000000000000',
        account_guid: 'src-acct-guid-000000000000000',
        quantity_num: -700n, // -7 shares
        quantity_denom: 100n,
        lot_guid: 'src-lot-1-guid-00000000000000',
        account: { guid: 'src-acct-guid-000000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
      },
      {
        guid: 'src-split-2-guid-000000000000',
        account_guid: 'src-acct-guid-000000000000000',
        quantity_num: -300n, // -3 shares
        quantity_denom: 100n,
        lot_guid: 'src-lot-2-guid-00000000000000',
        account: { guid: 'src-acct-guid-000000000000000', commodity_guid: 'aapl-commodity-guid-0000000000', account_type: 'STOCK' },
      },
    ] as never;

    mockSplitsFindUnique.mockResolvedValue(split);
    mockLotsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockSplitsUpdate.mockResolvedValue({});
    mockSplitsCreate.mockResolvedValue({});
    // acquisition dates
    mockSlotsFindFirst
      .mockResolvedValueOnce({ string_val: '2023-01-01T00:00:00.000Z' })
      .mockResolvedValueOnce({ string_val: '2023-06-01T00:00:00.000Z' });
    // Transaction balance check — return splits that sum to zero
    mockSplitsFindMany.mockResolvedValue([
      { value_num: 70000n, value_denom: 100n },   // first alloc: 7 shares @ $100 = $700
      { value_num: 30000n, value_denom: 100n },    // sub-split: 3 shares @ $100 = $300
      { value_num: -100000n, value_denom: 100n },  // source out: -$1000
    ]);

    const result = await splitTransferAcrossSourceLots(split.guid, runId, tx);

    expect(result.lotsCreated).toBe(2);
    expect(result.subSplitsCreated).toBe(1);

    // First allocation: quantity_num=700n (7 shares), value_num=70000n ($700)
    expect(mockSplitsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { guid: split.guid },
        data: expect.objectContaining({
          quantity_num: 700n,
          value_num: 70000n,
        }),
      }),
    );

    // Second allocation (remainder): quantity_num=300n (3 shares), value_num=30000n ($300)
    expect(mockSplitsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          quantity_num: 300n,
          value_num: 30000n,
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// C: generateCapitalGains
// ---------------------------------------------------------------------------

describe('generateCapitalGains', () => {
  const tx = createMockTx();
  const runId = 'run-003';

  const USD_GUID = 'usd-guid-00000000000000000000';
  const AAPL_GUID = 'aapl-guid-0000000000000000000';
  const INVEST_GUID = 'invest-acct-guid-000000000000';
  const PARENT_GUID = 'parent-guid-00000000000000000';
  const ROOT_GUID = 'root-guid';

  /** Minimal account hierarchy rows returned by accounts.findMany. */
  function baseAccountRows(extra: Array<Record<string, unknown>> = []) {
    return [
      { guid: INVEST_GUID, name: 'AAPL', parent_guid: PARENT_GUID, account_type: 'STOCK', commodity_guid: AAPL_GUID },
      { guid: PARENT_GUID, name: 'Brokerage', parent_guid: ROOT_GUID, account_type: 'ASSET', commodity_guid: USD_GUID },
      { guid: ROOT_GUID, name: 'Root', parent_guid: null, account_type: 'ROOT', commodity_guid: USD_GUID },
      ...extra,
    ];
  }

  /** USD is a CURRENCY (fraction 100); everything else is a stock commodity. */
  function mockCommodities() {
    mockCommoditiesFindUnique.mockImplementation(
      async (args: { where: { guid: string } }) =>
        args.where.guid === USD_GUID
          ? { namespace: 'CURRENCY', fraction: 100 }
          : { namespace: 'NASDAQ', fraction: 10000 },
    );
    mockCommoditiesFindMany.mockResolvedValue([{ guid: USD_GUID, fraction: 100 }]);
  }

  function makeLotWithSplits(opts: {
    lotGuid?: string;
    accountGuid?: string;
    commodityScu?: number;
    splits: Array<{
      qtyNum: bigint; qtyDenom: bigint;
      valNum: bigint; valDenom: bigint;
      postDate?: Date;
      currencyGuid?: string;
    }>;
    isClosed?: number;
  }) {
    return {
      guid: opts.lotGuid || 'lot-guid-00000000000000000000',
      account_guid: opts.accountGuid || 'invest-acct-guid-000000000000',
      is_closed: opts.isClosed ?? 0,
      account: {
        guid: opts.accountGuid || 'invest-acct-guid-000000000000',
        commodity_guid: 'aapl-guid-0000000000000000000',
        commodity_scu: opts.commodityScu || 100,
        parent_guid: 'parent-guid-00000000000000000',
      },
      splits: opts.splits.map((s, i) => ({
        guid: `split-${i}-guid-000000000000000000`,
        quantity_num: s.qtyNum,
        quantity_denom: s.qtyDenom,
        value_num: s.valNum,
        value_denom: s.valDenom,
        transaction: {
          post_date: s.postDate || new Date('2024-01-01'),
          currency_guid: s.currencyGuid || 'usd-guid-00000000000000000000',
        },
      })),
    };
  }

  it('C1: Taxable closed lot — generates gains transaction with ST/LT', async () => {
    // Native GnuCash signs: buy debits the stock account (+value),
    // sell credits it (-value).
    // Buy: 10 shares at $100 = +$1000, Sell: 10 shares at $150 = -$1500
    // Gain = proceeds - basis = 1500 - 1000 = $500
    const lot = makeLotWithSplits({
      splits: [
        { qtyNum: 1000n, qtyDenom: 100n, valNum: 100000n, valDenom: 100n, postDate: new Date('2024-01-01') },
        { qtyNum: -1000n, qtyDenom: 100n, valNum: -150000n, valDenom: 100n, postDate: new Date('2024-07-01') },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    // classifyAccountTax: walk up hierarchy, non-tax account
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'AAPL', parent_guid: 'parent-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Brokerage', parent_guid: 'root-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Root', parent_guid: null });
    // No acquisition_date slot
    mockSlotsFindFirst.mockResolvedValue(null);
    // Book
    mockAccountsFindMany.mockResolvedValue(baseAccountRows());
    mockCommodities();
    // findOrCreateAccount (Income:Capital Gains:Short Term)
    mockAccountsFindFirst
      .mockResolvedValueOnce({ guid: 'income-guid' })
      .mockResolvedValueOnce({ guid: 'capgains-guid' })
      .mockResolvedValueOnce({ guid: 'st-guid' });
    // Create tx and splits
    mockTransactionsCreate.mockResolvedValue({});
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockLotsUpdate.mockResolvedValue({});

    const result = await generateCapitalGains(lot.guid, runId, tx);

    expect(result.gainsTransactionGuid).toBeDefined();
    expect(result.gainLoss).toBeCloseTo(500);
    expect(result.holdingPeriod).toBe('short_term');
    expect(result.taxClassification).toBe('TAX_NORMAL');
    // Transaction created
    expect(mockTransactionsCreate).toHaveBeenCalledTimes(1);
    // Two splits created (invest + gains)
    expect(mockSplitsCreate).toHaveBeenCalledTimes(2);
    // Invest split zeroes the lot: lot sums to -500 (basis - proceeds), so +$500
    const investCall = mockSplitsCreate.mock.calls[0][0] as { data: { value_num: bigint; quantity_num: bigint } };
    expect(investCall.data.value_num).toBe(50000n);
    expect(investCall.data.quantity_num).toBe(0n);
    // Income split credits Capital Gains: -$500 (negative = income in GnuCash)
    const incomeCall = mockSplitsCreate.mock.calls[1][0] as { data: { value_num: bigint; quantity_num: bigint } };
    expect(incomeCall.data.value_num).toBe(-50000n);
    expect(incomeCall.data.quantity_num).toBe(0n);
    // Description reflects a GAIN
    expect(mockTransactionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: expect.stringContaining('Realized Gain'),
        }),
      }),
    );
    // Lot closed
    expect(mockLotsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { guid: lot.guid },
        data: { is_closed: 1 },
      }),
    );
  });

  it('C2: Tax-deferred — gains to Tax-Deferred account path', async () => {
    // Native signs: buy +$50, sell -$60 => gain $10
    const lot = makeLotWithSplits({
      splits: [
        { qtyNum: 100n, qtyDenom: 100n, valNum: 5000n, valDenom: 100n, postDate: new Date('2024-01-01') },
        { qtyNum: -100n, qtyDenom: 100n, valNum: -6000n, valDenom: 100n, postDate: new Date('2024-07-01') },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    // classifyAccountTax: IRA in hierarchy
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'AAPL', parent_guid: 'ira-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Traditional IRA', parent_guid: 'root-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Root', parent_guid: null });
    mockSlotsFindFirst.mockResolvedValue(null);
    mockAccountsFindMany.mockResolvedValue(baseAccountRows());
    mockCommodities();
    // findOrCreateAccount: Income:Capital Gains:Tax-Deferred:Short Term
    mockAccountsFindFirst
      .mockResolvedValueOnce({ guid: 'income-guid' })
      .mockResolvedValueOnce({ guid: 'capgains-guid' })
      .mockResolvedValueOnce({ guid: 'taxdef-guid' })
      .mockResolvedValueOnce({ guid: 'st-guid' });
    mockTransactionsCreate.mockResolvedValue({});
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockLotsUpdate.mockResolvedValue({});

    const result = await generateCapitalGains(lot.guid, runId, tx);

    expect(result.taxClassification).toBe('TAX_DEFERRED');
    expect(result.gainsTransactionGuid).toBeDefined();
    // findOrCreateAccount called with Tax-Deferred path
    expect(mockAccountsFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: 'Tax-Deferred', parent_guid: 'capgains-guid' },
      }),
    );
  });

  it('C3: Tax-exempt — skip gains, just close lot', async () => {
    const lot = makeLotWithSplits({
      splits: [
        { qtyNum: 100n, qtyDenom: 100n, valNum: 5000n, valDenom: 100n },
        { qtyNum: -100n, qtyDenom: 100n, valNum: -6000n, valDenom: 100n },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    // classifyAccountTax: Roth IRA in hierarchy
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'AAPL', parent_guid: 'roth-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Roth IRA', parent_guid: 'root-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Root', parent_guid: null });
    mockLotsUpdate.mockResolvedValue({});

    const result = await generateCapitalGains(lot.guid, runId, tx);

    expect(result.gainsTransactionGuid).toBeNull();
    expect(result.skippedReason).toContain('Tax-exempt');
    expect(result.taxClassification).toBe('TAX_EXEMPT');
    // Lot still closed
    expect(mockLotsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { guid: lot.guid },
        data: { is_closed: 1 },
      }),
    );
    // No transaction created
    expect(mockTransactionsCreate).not.toHaveBeenCalled();
  });

  it('C4: Pre-existing gains split — skip', async () => {
    const lot = makeLotWithSplits({
      splits: [
        { qtyNum: 100n, qtyDenom: 100n, valNum: 5000n, valDenom: 100n },
        { qtyNum: -100n, qtyDenom: 100n, valNum: -6000n, valDenom: 100n },
        // Pre-existing gains split (zero qty, non-zero value): +$10 gain offset
        { qtyNum: 0n, qtyDenom: 100n, valNum: 1000n, valDenom: 100n },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);

    const result = await generateCapitalGains(lot.guid, runId, tx);

    expect(result.gainsTransactionGuid).toBeNull();
    expect(result.skippedReason).toContain('Pre-existing gains split');
    expect(mockTransactionsCreate).not.toHaveBeenCalled();
  });

  it('C5: Short-term classification (< 1 year)', async () => {
    const lot = makeLotWithSplits({
      splits: [
        { qtyNum: 100n, qtyDenom: 100n, valNum: 5000n, valDenom: 100n, postDate: new Date('2024-06-01') },
        { qtyNum: -100n, qtyDenom: 100n, valNum: -6000n, valDenom: 100n, postDate: new Date('2024-11-01') },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'AAPL', parent_guid: 'brokerage-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Brokerage', parent_guid: null });
    mockSlotsFindFirst.mockResolvedValue(null);
    mockAccountsFindMany.mockResolvedValue(baseAccountRows());
    mockCommodities();
    mockAccountsFindFirst
      .mockResolvedValueOnce({ guid: 'income-guid' })
      .mockResolvedValueOnce({ guid: 'capgains-guid' })
      .mockResolvedValueOnce({ guid: 'st-guid' });
    mockTransactionsCreate.mockResolvedValue({});
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockLotsUpdate.mockResolvedValue({});

    const result = await generateCapitalGains(lot.guid, runId, tx);

    expect(result.holdingPeriod).toBe('short_term');
  });

  it('C6: Long-term classification (> 1 year)', async () => {
    const lot = makeLotWithSplits({
      splits: [
        { qtyNum: 100n, qtyDenom: 100n, valNum: 5000n, valDenom: 100n, postDate: new Date('2022-01-01') },
        { qtyNum: -100n, qtyDenom: 100n, valNum: -6000n, valDenom: 100n, postDate: new Date('2024-06-01') },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'AAPL', parent_guid: 'brokerage-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Brokerage', parent_guid: null });
    mockSlotsFindFirst.mockResolvedValue(null);
    mockAccountsFindMany.mockResolvedValue(baseAccountRows());
    mockCommodities();
    // Long Term path
    mockAccountsFindFirst
      .mockResolvedValueOnce({ guid: 'income-guid' })
      .mockResolvedValueOnce({ guid: 'capgains-guid' })
      .mockResolvedValueOnce({ guid: 'lt-guid' });
    mockTransactionsCreate.mockResolvedValue({});
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockLotsUpdate.mockResolvedValue({});

    const result = await generateCapitalGains(lot.guid, runId, tx);

    expect(result.holdingPeriod).toBe('long_term');
    // Should use Long Term account
    expect(mockAccountsFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: 'Long Term', parent_guid: 'capgains-guid' },
      }),
    );
  });

  it('C7: Loss lot — posts loss with correct signs and description', async () => {
    // Native signs: buy +$60, sell -$50 => loss of $10
    const lot = makeLotWithSplits({
      splits: [
        { qtyNum: 100n, qtyDenom: 100n, valNum: 6000n, valDenom: 100n, postDate: new Date('2024-01-01') },
        { qtyNum: -100n, qtyDenom: 100n, valNum: -5000n, valDenom: 100n, postDate: new Date('2024-07-01') },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'AAPL', parent_guid: 'brokerage-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Brokerage', parent_guid: null });
    mockSlotsFindFirst.mockResolvedValue(null);
    mockAccountsFindMany.mockResolvedValue(baseAccountRows());
    mockCommodities();
    mockAccountsFindFirst
      .mockResolvedValueOnce({ guid: 'income-guid' })
      .mockResolvedValueOnce({ guid: 'capgains-guid' })
      .mockResolvedValueOnce({ guid: 'st-guid' });
    mockTransactionsCreate.mockResolvedValue({});
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockLotsUpdate.mockResolvedValue({});

    const result = await generateCapitalGains(lot.guid, runId, tx);

    expect(result.gainLoss).toBeCloseTo(-10);
    // Invest split: lot sums to +10 (basis - proceeds), so -$10 zeroes it
    const investCall = mockSplitsCreate.mock.calls[0][0] as { data: { value_num: bigint } };
    expect(investCall.data.value_num).toBe(-1000n);
    // Income split: +$10 (debit = loss reduces income)
    const incomeCall = mockSplitsCreate.mock.calls[1][0] as { data: { value_num: bigint } };
    expect(incomeCall.data.value_num).toBe(1000n);
    expect(mockTransactionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: expect.stringContaining('Realized Loss'),
        }),
      }),
    );
  });

  it('should use commodity_scu from account, not hardcoded 100', async () => {
    const lot = makeLotWithSplits({
      commodityScu: 10000, // 4 decimal places
      splits: [
        { qtyNum: 10000n, qtyDenom: 10000n, valNum: 5000n, valDenom: 100n, postDate: new Date('2024-01-01') },
        { qtyNum: -10000n, qtyDenom: 10000n, valNum: -6000n, valDenom: 100n, postDate: new Date('2024-07-01') },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'BTC', parent_guid: 'exchange-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Exchange', parent_guid: null });
    mockSlotsFindFirst.mockResolvedValue(null);
    mockAccountsFindMany.mockResolvedValue(baseAccountRows());
    mockCommodities();
    mockAccountsFindFirst
      .mockResolvedValueOnce({ guid: 'income-guid' })
      .mockResolvedValueOnce({ guid: 'capgains-guid' })
      .mockResolvedValueOnce({ guid: 'st-guid' });
    mockTransactionsCreate.mockResolvedValue({});
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockLotsUpdate.mockResolvedValue({});

    await generateCapitalGains(lot.guid, runId, tx);

    // The invest split should use 10000 as denom for quantity
    const investSplitCall = mockSplitsCreate.mock.calls[0][0] as { data: { quantity_denom: bigint } };
    expect(investSplitCall.data.quantity_denom).toBe(10000n);
  });

  it('should check acquisition_date slot for holding period', async () => {
    // Lot splits say 2024, but acquisition_date slot says 2022 (transferred from old lot)
    const lot = makeLotWithSplits({
      splits: [
        { qtyNum: 100n, qtyDenom: 100n, valNum: 5000n, valDenom: 100n, postDate: new Date('2024-06-01') },
        { qtyNum: -100n, qtyDenom: 100n, valNum: -6000n, valDenom: 100n, postDate: new Date('2024-11-01') },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'AAPL', parent_guid: 'p' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Brokerage', parent_guid: null });
    // Return acquisition_date from 2022 — this should make it long_term
    mockSlotsFindFirst.mockResolvedValue({ string_val: '2022-01-01T00:00:00.000Z' });
    mockAccountsFindMany.mockResolvedValue(baseAccountRows());
    mockCommodities();
    mockAccountsFindFirst
      .mockResolvedValueOnce({ guid: 'income-guid' })
      .mockResolvedValueOnce({ guid: 'capgains-guid' })
      .mockResolvedValueOnce({ guid: 'lt-guid' });
    mockTransactionsCreate.mockResolvedValue({});
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockLotsUpdate.mockResolvedValue({});

    const result = await generateCapitalGains(lot.guid, runId, tx);

    // Without the slot it would be short_term (Jun-Nov 2024).
    // With acquisition_date from 2022, it should be long_term.
    expect(result.holdingPeriod).toBe('long_term');
  });

  it('C8: commodity-denominated source tx — currency falls back to ancestor CURRENCY, value uses currency fraction', async () => {
    // Crypto-style account: scu 1e9; the source buy/sell transactions are
    // (incorrectly) denominated in the commodity itself, as imported data
    // sometimes is. Buy 2 @ $500 = +$1000, sell 2 @ $750 = -$1500 => gain $500.
    const lot = makeLotWithSplits({
      commodityScu: 1000000000,
      splits: [
        { qtyNum: 2000000000n, qtyDenom: 1000000000n, valNum: 100000n, valDenom: 100n, postDate: new Date('2024-01-01'), currencyGuid: AAPL_GUID },
        { qtyNum: -2000000000n, qtyDenom: 1000000000n, valNum: -150000n, valDenom: 100n, postDate: new Date('2024-07-01'), currencyGuid: AAPL_GUID },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'VT', parent_guid: 'brokerage-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Brokerage', parent_guid: null });
    mockSlotsFindFirst.mockResolvedValue(null);
    mockAccountsFindMany.mockResolvedValue(baseAccountRows());
    mockCommodities();
    mockAccountsFindFirst
      .mockResolvedValueOnce({ guid: 'income-guid' })
      .mockResolvedValueOnce({ guid: 'capgains-guid' })
      .mockResolvedValueOnce({ guid: 'st-guid' });
    mockTransactionsCreate.mockResolvedValue({});
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockLotsUpdate.mockResolvedValue({});

    const result = await generateCapitalGains(lot.guid, runId, tx);

    expect(result.gainsTransactionGuid).toBeDefined();
    expect(result.gainLoss).toBeCloseTo(500);
    // Transaction currency is the ancestor account's CURRENCY (USD), NOT the
    // commodity the source transaction was denominated in.
    expect(mockTransactionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currency_guid: USD_GUID }),
      }),
    );
    // Values use the currency fraction (100), NOT the commodity scu (1e9);
    // quantities keep the commodity scu.
    const investCall = mockSplitsCreate.mock.calls[0][0] as {
      data: { value_num: bigint; value_denom: bigint; quantity_denom: bigint };
    };
    expect(investCall.data.value_num).toBe(50000n);
    expect(investCall.data.value_denom).toBe(100n);
    expect(investCall.data.quantity_denom).toBe(1000000000n);
    const incomeCall = mockSplitsCreate.mock.calls[1][0] as {
      data: { value_num: bigint; value_denom: bigint };
    };
    expect(incomeCall.data.value_num).toBe(-50000n);
    expect(incomeCall.data.value_denom).toBe(100n);
  });

  it('C9: no CURRENCY ancestor — falls back to most-common CURRENCY commodity across accounts', async () => {
    const lot = makeLotWithSplits({
      splits: [
        { qtyNum: 100n, qtyDenom: 100n, valNum: 5000n, valDenom: 100n, postDate: new Date('2024-01-01'), currencyGuid: AAPL_GUID },
        { qtyNum: -100n, qtyDenom: 100n, valNum: -6000n, valDenom: 100n, postDate: new Date('2024-07-01'), currencyGuid: AAPL_GUID },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'VT', parent_guid: 'brokerage-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Brokerage', parent_guid: null });
    mockSlotsFindFirst.mockResolvedValue(null);
    // No ancestor carries a CURRENCY commodity; USD backs 2 accounts, EUR 1.
    mockAccountsFindMany.mockResolvedValue([
      { guid: INVEST_GUID, name: 'VT', parent_guid: PARENT_GUID, account_type: 'STOCK', commodity_guid: AAPL_GUID },
      { guid: PARENT_GUID, name: 'Brokerage', parent_guid: ROOT_GUID, account_type: 'ASSET', commodity_guid: AAPL_GUID },
      { guid: ROOT_GUID, name: 'Root', parent_guid: null, account_type: 'ROOT', commodity_guid: null },
      { guid: 'bank-1-guid', name: 'Checking', parent_guid: ROOT_GUID, account_type: 'BANK', commodity_guid: USD_GUID },
      { guid: 'bank-2-guid', name: 'Savings', parent_guid: ROOT_GUID, account_type: 'BANK', commodity_guid: USD_GUID },
      { guid: 'bank-3-guid', name: 'Euro Cash', parent_guid: ROOT_GUID, account_type: 'BANK', commodity_guid: 'eur-guid-00000000000000000000' },
    ]);
    mockCommoditiesFindUnique.mockImplementation(
      async (args: { where: { guid: string } }) =>
        args.where.guid === AAPL_GUID
          ? { namespace: 'NASDAQ', fraction: 10000 }
          : { namespace: 'CURRENCY', fraction: 100 },
    );
    mockCommoditiesFindMany.mockResolvedValue([
      { guid: 'eur-guid-00000000000000000000', fraction: 100 },
      { guid: USD_GUID, fraction: 100 },
    ]);
    mockAccountsFindFirst
      .mockResolvedValueOnce({ guid: 'income-guid' })
      .mockResolvedValueOnce({ guid: 'capgains-guid' })
      .mockResolvedValueOnce({ guid: 'st-guid' });
    mockTransactionsCreate.mockResolvedValue({});
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockLotsUpdate.mockResolvedValue({});

    const result = await generateCapitalGains(lot.guid, runId, tx);

    expect(result.gainsTransactionGuid).toBeDefined();
    // USD backs 2 accounts vs EUR's 1 — the most-common CURRENCY wins
    expect(mockTransactionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currency_guid: USD_GUID }),
      }),
    );
  });

  it('C10: existing Income:Investment:Capital Gains:Long Term:taxable account is found and reused', async () => {
    // Long-term taxable gain
    const lot = makeLotWithSplits({
      splits: [
        { qtyNum: 100n, qtyDenom: 100n, valNum: 5000n, valDenom: 100n, postDate: new Date('2022-01-01') },
        { qtyNum: -100n, qtyDenom: 100n, valNum: -6000n, valDenom: 100n, postDate: new Date('2024-06-01') },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'AAPL', parent_guid: 'brokerage-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Brokerage', parent_guid: null });
    mockSlotsFindFirst.mockResolvedValue(null);
    mockAccountsFindMany.mockResolvedValue(baseAccountRows([
      { guid: 'income-acct-guid', name: 'Income', parent_guid: ROOT_GUID, account_type: 'INCOME', commodity_guid: USD_GUID },
      { guid: 'inv-income-guid', name: 'Investment', parent_guid: 'income-acct-guid', account_type: 'INCOME', commodity_guid: USD_GUID },
      { guid: 'cg-guid', name: 'Capital Gains', parent_guid: 'inv-income-guid', account_type: 'INCOME', commodity_guid: USD_GUID },
      { guid: 'cg-lt-guid', name: 'Long Term', parent_guid: 'cg-guid', account_type: 'INCOME', commodity_guid: USD_GUID },
      { guid: 'cg-lt-taxable-guid', name: 'taxable', parent_guid: 'cg-lt-guid', account_type: 'INCOME', commodity_guid: USD_GUID },
      { guid: 'cg-lt-nontax-guid', name: 'non-taxable', parent_guid: 'cg-lt-guid', account_type: 'INCOME', commodity_guid: USD_GUID },
    ]));
    mockCommodities();
    mockTransactionsCreate.mockResolvedValue({});
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockLotsUpdate.mockResolvedValue({});

    const result = await generateCapitalGains(lot.guid, runId, tx);

    expect(result.gainsTransactionGuid).toBeDefined();
    expect(result.holdingPeriod).toBe('long_term');
    expect(result.taxClassification).toBe('TAX_NORMAL');
    // Income split posted to the EXISTING taxable long-term account
    const incomeCall = mockSplitsCreate.mock.calls[1][0] as { data: { account_guid: string } };
    expect(incomeCall.data.account_guid).toBe('cg-lt-taxable-guid');
    // No account lookup-by-path or creation happened
    expect(mockAccountsFindFirst).not.toHaveBeenCalled();
    expect(mockAccountsCreate).not.toHaveBeenCalled();
  });

  it('C11: TAX_DEFERRED prefers the existing non-taxable capital gains account', async () => {
    const lot = makeLotWithSplits({
      splits: [
        { qtyNum: 100n, qtyDenom: 100n, valNum: 5000n, valDenom: 100n, postDate: new Date('2022-01-01') },
        { qtyNum: -100n, qtyDenom: 100n, valNum: -6000n, valDenom: 100n, postDate: new Date('2024-06-01') },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    // classifyAccountTax: Traditional IRA => TAX_DEFERRED
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'AAPL', parent_guid: 'ira-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Traditional IRA', parent_guid: null });
    mockSlotsFindFirst.mockResolvedValue(null);
    mockAccountsFindMany.mockResolvedValue(baseAccountRows([
      { guid: 'income-acct-guid', name: 'Income', parent_guid: ROOT_GUID, account_type: 'INCOME', commodity_guid: USD_GUID },
      { guid: 'inv-income-guid', name: 'Investment', parent_guid: 'income-acct-guid', account_type: 'INCOME', commodity_guid: USD_GUID },
      { guid: 'cg-guid', name: 'Capital Gains', parent_guid: 'inv-income-guid', account_type: 'INCOME', commodity_guid: USD_GUID },
      { guid: 'cg-lt-guid', name: 'Long Term', parent_guid: 'cg-guid', account_type: 'INCOME', commodity_guid: USD_GUID },
      { guid: 'cg-lt-taxable-guid', name: 'taxable', parent_guid: 'cg-lt-guid', account_type: 'INCOME', commodity_guid: USD_GUID },
      { guid: 'cg-lt-nontax-guid', name: 'non-taxable', parent_guid: 'cg-lt-guid', account_type: 'INCOME', commodity_guid: USD_GUID },
    ]));
    mockCommodities();
    mockTransactionsCreate.mockResolvedValue({});
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockLotsUpdate.mockResolvedValue({});

    const result = await generateCapitalGains(lot.guid, runId, tx);

    expect(result.taxClassification).toBe('TAX_DEFERRED');
    const incomeCall = mockSplitsCreate.mock.calls[1][0] as { data: { account_guid: string } };
    expect(incomeCall.data.account_guid).toBe('cg-lt-nontax-guid');
    expect(mockAccountsFindFirst).not.toHaveBeenCalled();
    expect(mockAccountsCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// classifyAccountTax
// ---------------------------------------------------------------------------

describe('classifyAccountTax', () => {
  const tx = createMockTx();

  it('returns TAX_NORMAL for regular brokerage accounts', async () => {
    mockAccountsFindUnique
      .mockResolvedValueOnce({ name: 'AAPL', parent_guid: 'brokerage-guid' })
      .mockResolvedValueOnce({ name: 'Brokerage', parent_guid: 'root-guid' })
      .mockResolvedValueOnce({ name: 'Root Account', parent_guid: null });

    const result = await classifyAccountTax('aapl-guid', tx);
    expect(result).toBe('TAX_NORMAL');
  });

  it('returns TAX_DEFERRED for Traditional IRA accounts', async () => {
    mockAccountsFindUnique
      .mockResolvedValueOnce({ name: 'VTSAX', parent_guid: 'ira-guid' })
      .mockResolvedValueOnce({ name: 'Traditional IRA', parent_guid: 'root-guid' })
      .mockResolvedValueOnce({ name: 'Root', parent_guid: null });

    const result = await classifyAccountTax('vtsax-guid', tx);
    expect(result).toBe('TAX_DEFERRED');
  });

  it('returns TAX_DEFERRED for 401k accounts', async () => {
    mockAccountsFindUnique
      .mockResolvedValueOnce({ name: 'Target 2040', parent_guid: '401k-guid' })
      .mockResolvedValueOnce({ name: '401k', parent_guid: 'root-guid' })
      .mockResolvedValueOnce({ name: 'Root', parent_guid: null });

    const result = await classifyAccountTax('target-guid', tx);
    expect(result).toBe('TAX_DEFERRED');
  });

  it('returns TAX_EXEMPT for Roth IRA accounts', async () => {
    mockAccountsFindUnique
      .mockResolvedValueOnce({ name: 'VTSAX', parent_guid: 'roth-guid' })
      .mockResolvedValueOnce({ name: 'Roth IRA', parent_guid: 'root-guid' })
      .mockResolvedValueOnce({ name: 'Root', parent_guid: null });

    const result = await classifyAccountTax('vtsax-guid', tx);
    expect(result).toBe('TAX_EXEMPT');
  });

  it('returns TAX_EXEMPT for HSA accounts', async () => {
    mockAccountsFindUnique
      .mockResolvedValueOnce({ name: 'VFIAX', parent_guid: 'hsa-guid' })
      .mockResolvedValueOnce({ name: 'HSA', parent_guid: 'root-guid' })
      .mockResolvedValueOnce({ name: 'Root', parent_guid: null });

    const result = await classifyAccountTax('vfiax-guid', tx);
    expect(result).toBe('TAX_EXEMPT');
  });

  it('returns TAX_EXEMPT for Roth 401k', async () => {
    mockAccountsFindUnique
      .mockResolvedValueOnce({ name: 'Fund A', parent_guid: 'r401k-guid' })
      .mockResolvedValueOnce({ name: 'Roth 401k', parent_guid: 'root-guid' })
      .mockResolvedValueOnce({ name: 'Root', parent_guid: null });

    const result = await classifyAccountTax('fund-guid', tx);
    expect(result).toBe('TAX_EXEMPT');
  });

  it('returns TAX_DEFERRED for 403b accounts', async () => {
    mockAccountsFindUnique
      .mockResolvedValueOnce({ name: 'Fund B', parent_guid: '403b-guid' })
      .mockResolvedValueOnce({ name: '403b Plan', parent_guid: 'root-guid' })
      .mockResolvedValueOnce({ name: 'Root', parent_guid: null });

    const result = await classifyAccountTax('fund-guid', tx);
    expect(result).toBe('TAX_DEFERRED');
  });
});

// ---------------------------------------------------------------------------
// classifyHoldingPeriod
// ---------------------------------------------------------------------------

describe('classifyHoldingPeriod', () => {
  it('returns short_term for < 365 days', () => {
    const open = new Date('2024-01-01');
    const close = new Date('2024-06-01');
    expect(classifyHoldingPeriod(open, close)).toBe('short_term');
  });

  it('returns long_term for > 365 days', () => {
    const open = new Date('2022-01-01');
    const close = new Date('2024-01-02');
    expect(classifyHoldingPeriod(open, close)).toBe('long_term');
  });

  it('returns short_term for exactly 365 days', () => {
    const open = new Date('2024-01-01');
    // 365 days from Jan 1 = Dec 31 of same year
    const close365 = new Date('2024-12-31');
    expect(classifyHoldingPeriod(open, close365)).toBe('short_term');
  });

  it('returns long_term for 366 days', () => {
    const open = new Date('2024-01-01');
    const close = new Date('2025-01-02'); // > 365 days
    expect(classifyHoldingPeriod(open, close)).toBe('long_term');
  });

  it('returns short_term for same day', () => {
    const date = new Date('2024-06-15');
    expect(classifyHoldingPeriod(date, date)).toBe('short_term');
  });
});
