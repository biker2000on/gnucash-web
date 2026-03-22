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
const mockAccountsCreate = vi.fn();
const mockBooksFindFirst = vi.fn();
const mockTransactionsCreate = vi.fn();

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
      create: (...args: unknown[]) => mockAccountsCreate(...args),
    },
    books: {
      findFirst: (...args: unknown[]) => mockBooksFindFirst(...args),
    },
    transactions: {
      create: (...args: unknown[]) => mockTransactionsCreate(...args),
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
      create: mockAccountsCreate,
    },
    books: {
      findFirst: mockBooksFindFirst,
    },
    transactions: {
      create: mockTransactionsCreate,
    },
  } as any;
}

import {
  splitSellAcrossLots,
  linkTransferToLot,
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

function makeSplit(overrides: Record<string, unknown> = {}) {
  return {
    guid: 'sell-split-guid-00000000000000',
    tx_guid: 'tx-guid-000000000000000000000',
    account_guid: 'acct-guid-0000000000000000000',
    memo: '',
    action: '',
    reconcile_state: 'n',
    reconcile_date: null,
    value_num: 10000n,   // +$100 (sell proceeds)
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
      value_num: 15000n,   // +$150
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
      value_num: 45000n,   // +$450
      value_denom: 100n,
    });
    mockSplitsFindUnique.mockResolvedValue(sellSplit);
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockSplitsUpdate.mockResolvedValue({});
    // Transaction balance check — return splits that sum to zero
    mockSplitsFindMany.mockResolvedValue([
      { value_num: 22500n, value_denom: 100n },  // first alloc: 1.5 shares * $150 = $225
      { value_num: 22500n, value_denom: 100n },  // sub-split: 1.5 shares * $150 = $225
      { value_num: -45000n, value_denom: 100n },  // cash side
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
    // Sub-split created for second lot
    expect(mockSplitsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tx_guid: sellSplit.tx_guid,
          account_guid: sellSplit.account_guid,
          lot_guid: 'lot-b-guid-00000000000000000',
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
      value_num: 50000n,
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
      value_num: 100000n,
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
      value_num: 30000n,
      value_denom: 100n,
    });
    mockSplitsFindUnique.mockResolvedValue(sellSplit);
    mockSplitsCreate.mockResolvedValue({});
    mockSlotsCreate.mockResolvedValue({});
    mockSplitsUpdate.mockResolvedValue({});
    // Return imbalanced transaction
    mockSplitsFindMany.mockResolvedValue([
      { value_num: 15000n, value_denom: 100n },
      { value_num: 15000n, value_denom: 100n },
      { value_num: -20000n, value_denom: 100n }, // $100 imbalance
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
    const slotCreateCalls = mockSlotsCreate.mock.calls.map(c => (c[0] as any).data.name);
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
// C: generateCapitalGains
// ---------------------------------------------------------------------------

describe('generateCapitalGains', () => {
  const tx = createMockTx();
  const runId = 'run-003';

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
    // Buy: 10 shares at $100 = -$1000, Sell: 10 shares at $150 = +$1500
    // Gain = -1000 + 1500 = $500
    const lot = makeLotWithSplits({
      splits: [
        { qtyNum: 1000n, qtyDenom: 100n, valNum: -100000n, valDenom: 100n, postDate: new Date('2024-01-01') },
        { qtyNum: -1000n, qtyDenom: 100n, valNum: 150000n, valDenom: 100n, postDate: new Date('2024-07-01') },
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
    mockBooksFindFirst.mockResolvedValue({ root_account_guid: 'root-guid' });
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
    // Lot closed
    expect(mockLotsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { guid: lot.guid },
        data: { is_closed: 1 },
      }),
    );
  });

  it('C2: Tax-deferred — gains to Tax-Deferred account path', async () => {
    const lot = makeLotWithSplits({
      splits: [
        { qtyNum: 100n, qtyDenom: 100n, valNum: -5000n, valDenom: 100n, postDate: new Date('2024-01-01') },
        { qtyNum: -100n, qtyDenom: 100n, valNum: 6000n, valDenom: 100n, postDate: new Date('2024-07-01') },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    // classifyAccountTax: IRA in hierarchy
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'AAPL', parent_guid: 'ira-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Traditional IRA', parent_guid: 'root-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Root', parent_guid: null });
    mockSlotsFindFirst.mockResolvedValue(null);
    mockBooksFindFirst.mockResolvedValue({ root_account_guid: 'root-guid' });
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
        { qtyNum: 100n, qtyDenom: 100n, valNum: -5000n, valDenom: 100n },
        { qtyNum: -100n, qtyDenom: 100n, valNum: 6000n, valDenom: 100n },
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
        { qtyNum: 100n, qtyDenom: 100n, valNum: -5000n, valDenom: 100n },
        { qtyNum: -100n, qtyDenom: 100n, valNum: 6000n, valDenom: 100n },
        // Pre-existing gains split (zero qty, non-zero value)
        { qtyNum: 0n, qtyDenom: 100n, valNum: -1000n, valDenom: 100n },
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
        { qtyNum: 100n, qtyDenom: 100n, valNum: -5000n, valDenom: 100n, postDate: new Date('2024-06-01') },
        { qtyNum: -100n, qtyDenom: 100n, valNum: 6000n, valDenom: 100n, postDate: new Date('2024-11-01') },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'AAPL', parent_guid: 'brokerage-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Brokerage', parent_guid: null });
    mockSlotsFindFirst.mockResolvedValue(null);
    mockBooksFindFirst.mockResolvedValue({ root_account_guid: 'root-guid' });
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
        { qtyNum: 100n, qtyDenom: 100n, valNum: -5000n, valDenom: 100n, postDate: new Date('2022-01-01') },
        { qtyNum: -100n, qtyDenom: 100n, valNum: 6000n, valDenom: 100n, postDate: new Date('2024-06-01') },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'AAPL', parent_guid: 'brokerage-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Brokerage', parent_guid: null });
    mockSlotsFindFirst.mockResolvedValue(null);
    mockBooksFindFirst.mockResolvedValue({ root_account_guid: 'root-guid' });
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

  it('should use commodity_scu from account, not hardcoded 100', async () => {
    const lot = makeLotWithSplits({
      commodityScu: 10000, // 4 decimal places
      splits: [
        { qtyNum: 10000n, qtyDenom: 10000n, valNum: -5000n, valDenom: 100n, postDate: new Date('2024-01-01') },
        { qtyNum: -10000n, qtyDenom: 10000n, valNum: 6000n, valDenom: 100n, postDate: new Date('2024-07-01') },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'BTC', parent_guid: 'exchange-guid' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Exchange', parent_guid: null });
    mockSlotsFindFirst.mockResolvedValue(null);
    mockBooksFindFirst.mockResolvedValue({ root_account_guid: 'root-guid' });
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
    const investSplitCall = mockSplitsCreate.mock.calls[0][0] as any;
    expect(investSplitCall.data.quantity_denom).toBe(10000n);
  });

  it('should check acquisition_date slot for holding period', async () => {
    // Lot splits say 2024, but acquisition_date slot says 2022 (transferred from old lot)
    const lot = makeLotWithSplits({
      splits: [
        { qtyNum: 100n, qtyDenom: 100n, valNum: -5000n, valDenom: 100n, postDate: new Date('2024-06-01') },
        { qtyNum: -100n, qtyDenom: 100n, valNum: 6000n, valDenom: 100n, postDate: new Date('2024-11-01') },
      ],
    });

    mockLotsFindUnique.mockResolvedValue(lot);
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'AAPL', parent_guid: 'p' });
    mockAccountsFindUnique.mockResolvedValueOnce({ name: 'Brokerage', parent_guid: null });
    // Return acquisition_date from 2022 — this should make it long_term
    mockSlotsFindFirst.mockResolvedValue({ string_val: '2022-01-01T00:00:00.000Z' });
    mockBooksFindFirst.mockResolvedValue({ root_account_guid: 'root-guid' });
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
    const close = new Date('2025-01-01'); // exactly 366 days (leap year) but close enough
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
