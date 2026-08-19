/**
 * The two lot-consuming API routes report figures NET of brokerage
 * commissions — the same treatment Form 8949, the Investment Lots report and
 * the ledger apply.
 *
 * Both routes used to call getAccountLots() without `includeTradeFees`, so
 * GET /api/accounts/:guid/lots and the tax-harvesting report quoted GROSS
 * basis and gains while every other money surface quoted net. These tests
 * drive the REAL lot engine and the REAL fee allocator over one mocked book
 * and pin the netted numbers (and the gross ones they replaced).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  prismaMock,
  requireRoleMock,
  isAccountInActiveBookMock,
  getBookAccountGuidsMock,
  buildAccountPathMapMock,
  getRetirementAccountGuidsMock,
  detectWashSalesMock,
  getLatestPriceMock,
} = vi.hoisted(() => ({
  prismaMock: {
    lots: { findMany: vi.fn() },
    slots: { findMany: vi.fn() },
    accounts: { findMany: vi.fn() },
    splits: { findMany: vi.fn() },
  },
  requireRoleMock: vi.fn(),
  isAccountInActiveBookMock: vi.fn(),
  getBookAccountGuidsMock: vi.fn(),
  buildAccountPathMapMock: vi.fn(),
  getRetirementAccountGuidsMock: vi.fn(),
  detectWashSalesMock: vi.fn(),
  getLatestPriceMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/book-scope', () => ({
  requireRole: requireRoleMock,
  isAccountInActiveBook: isAccountInActiveBookMock,
  getBookAccountGuids: getBookAccountGuidsMock,
}));
vi.mock('@/lib/reports/utils', () => ({ buildAccountPathMap: buildAccountPathMapMock }));
vi.mock('@/lib/reports/contribution-classifier', () => ({
  getRetirementAccountGuids: getRetirementAccountGuidsMock,
}));
vi.mock('@/lib/lot-assignment', () => ({ detectWashSales: detectWashSalesMock }));
vi.mock('@/lib/commodities', () => ({ getLatestPrice: getLatestPriceMock }));

import { GET as accountLotsGET } from '../accounts/[guid]/lots/route';
import { GET as harvestingGET } from '../reports/tax-harvesting/route';

const ACCT = 'acct-stock';
const CASH = 'acct-cash';
const COMMISSIONS = 'acct-commissions';
const COMMODITY = 'commodity-aapl';

const ACCOUNT_PATHS = new Map([
  [ACCT, 'Assets:Investments:Brokerage:AAPL'],
  [CASH, 'Assets:Investments:Brokerage:Cash'],
  [COMMISSIONS, 'Expenses:Investments:Commissions'],
]);

interface FixtureSplit {
  guid: string;
  txGuid: string;
  postDate: string;
  description: string;
  accountGuid: string;
  accountType: 'STOCK' | 'EXPENSE' | 'BANK';
  shares: number;
  value: number;
  lotGuid?: string;
}

const qty = (shares: number) => BigInt(Math.round(shares * 10_000));
const cents = (value: number) => BigInt(Math.round(value * 100));

let book: FixtureSplit[] = [];

function lotSplitRow(split: FixtureSplit) {
  return {
    guid: split.guid,
    tx_guid: split.txGuid,
    quantity_num: qty(split.shares),
    quantity_denom: 10_000n,
    value_num: cents(split.value),
    value_denom: 100n,
    transaction: {
      post_date: new Date(`${split.postDate}T12:00:00.000Z`),
      description: split.description,
      splits: book
        .filter(sibling => sibling.txGuid === split.txGuid)
        .map(sibling => ({
          account_guid: sibling.accountGuid,
          quantity_num: qty(sibling.shares),
          quantity_denom: 10_000n,
          account: {
            commodity_guid: sibling.accountGuid === ACCT ? COMMODITY : null,
            account_type: sibling.accountType,
          },
        })),
    },
  };
}

function feeQueryRow(split: FixtureSplit) {
  return {
    guid: split.guid,
    tx_guid: split.txGuid,
    account_guid: split.accountGuid,
    value_num: cents(split.value),
    value_denom: 100n,
    quantity_num: qty(split.shares),
    quantity_denom: 10_000n,
    account: {
      name: (ACCOUNT_PATHS.get(split.accountGuid) ?? '').split(':').pop() ?? '',
      account_type: split.accountType,
    },
    transaction: {
      post_date: new Date(`${split.postDate}T12:00:00.000Z`),
      description: split.description,
    },
  };
}

function installBook(lots: Array<{ guid: string; isClosed: 0 | 1 }>) {
  prismaMock.lots.findMany.mockResolvedValue(lots.map(l => ({
    guid: l.guid,
    account_guid: ACCT,
    is_closed: l.isClosed,
    splits: book.filter(s => s.lotGuid === l.guid).map(lotSplitRow),
  })));
  // The lot engine's account lookup AND the tax-harvesting route's investment
  // account query both land here; one row carries the fields both select.
  prismaMock.accounts.findMany.mockResolvedValue([
    { guid: ACCT, name: 'AAPL', commodity_guid: COMMODITY, commodity: { mnemonic: 'AAPL' } },
  ]);
  prismaMock.splits.findMany.mockImplementation(
    async (args: { where: { tx_guid?: { in: string[] }; lot_guid?: null } }) => {
      const wanted = args.where.tx_guid ? new Set(args.where.tx_guid.in) : null;
      if (!wanted) return []; // getFreeSplits
      return book.filter(s => wanted.has(s.txGuid)).map(feeQueryRow);
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  book = [];
  requireRoleMock.mockResolvedValue({ user: { id: 1 }, bookGuid: 'book-guid', role: 'readonly' });
  isAccountInActiveBookMock.mockResolvedValue(true);
  getBookAccountGuidsMock.mockResolvedValue([ACCT, CASH, COMMISSIONS]);
  buildAccountPathMapMock.mockResolvedValue(ACCOUNT_PATHS);
  getRetirementAccountGuidsMock.mockResolvedValue(new Set<string>());
  detectWashSalesMock.mockResolvedValue([]);
  prismaMock.slots.findMany.mockResolvedValue([]);
  getLatestPriceMock.mockResolvedValue(null);
});

describe('GET /api/accounts/[guid]/lots', () => {
  beforeEach(() => {
    // Buy 10 AAPL for $1,000 with a $10 commission; sell all 10 for $1,500
    // with a $12 commission. Pub. 550: basis $1,010, amount realized $1,488,
    // gain $478 — the gross figures are $1,000 / $500.
    book = [
      { guid: 'buy', txGuid: 'tx-buy', postDate: '2023-01-10', description: 'Buy 10 AAPL', accountGuid: ACCT, accountType: 'STOCK', shares: 10, value: 1_000, lotGuid: 'lot-1' },
      { guid: 'buy-fee', txGuid: 'tx-buy', postDate: '2023-01-10', description: 'Buy 10 AAPL', accountGuid: COMMISSIONS, accountType: 'EXPENSE', shares: 0, value: 10 },
      { guid: 'buy-cash', txGuid: 'tx-buy', postDate: '2023-01-10', description: 'Buy 10 AAPL', accountGuid: CASH, accountType: 'BANK', shares: -1_010, value: -1_010 },
      { guid: 'sell', txGuid: 'tx-sell', postDate: '2024-06-20', description: 'Sell 10 AAPL', accountGuid: ACCT, accountType: 'STOCK', shares: -10, value: -1_500, lotGuid: 'lot-1' },
      { guid: 'sell-fee', txGuid: 'tx-sell', postDate: '2024-06-20', description: 'Sell 10 AAPL', accountGuid: COMMISSIONS, accountType: 'EXPENSE', shares: 0, value: 12 },
      { guid: 'sell-cash', txGuid: 'tx-sell', postDate: '2024-06-20', description: 'Sell 10 AAPL', accountGuid: CASH, accountType: 'BANK', shares: 1_488, value: 1_488 },
    ];
    installBook([{ guid: 'lot-1', isClosed: 1 }]);
  });

  async function lots() {
    const response = await accountLotsGET(
      new Request(`http://localhost/api/accounts/${ACCT}/lots`),
      { params: Promise.resolve({ guid: ACCT }) },
    ) as unknown as Response;
    expect(response.status).toBe(200);
    return await response.json() as {
      lots: Array<{ totalCost: number; realizedGain: number | null; tradeFees: number }>;
      warnings?: string[];
    };
  }

  it('returns basis and realized gain NET of both commissions', async () => {
    const body = await lots();

    expect(body.lots).toHaveLength(1);
    expect(body.lots[0].totalCost).toBeCloseTo(1_010, 6); // was 1_000 (gross)
    expect(body.lots[0].realizedGain).toBeCloseTo(478, 6); // was 500 (gross)
    expect(body.lots[0].tradeFees).toBeCloseTo(22, 6);
  });

  it('classifies the fees against the FULL account paths, book-scoped', async () => {
    await lots();

    expect(getBookAccountGuidsMock).toHaveBeenCalled();
    expect(buildAccountPathMapMock).toHaveBeenCalledWith([ACCT, CASH, COMMISSIONS]);
  });

  it('omits the warnings key when the allocator had nothing to report', async () => {
    const body = await lots();
    expect(body.warnings).toBeUndefined();
  });
});

describe('GET /api/reports/tax-harvesting', () => {
  beforeEach(() => {
    // Buy 10 AAPL for $1,000 with a $10 commission, still held. At $90/share
    // the harvestable loss is $900 - $1,010 = -$110 net, -$100 gross.
    book = [
      { guid: 'buy', txGuid: 'tx-buy', postDate: '2023-01-10', description: 'Buy 10 AAPL', accountGuid: ACCT, accountType: 'STOCK', shares: 10, value: 1_000, lotGuid: 'lot-1' },
      { guid: 'buy-fee', txGuid: 'tx-buy', postDate: '2023-01-10', description: 'Buy 10 AAPL', accountGuid: COMMISSIONS, accountType: 'EXPENSE', shares: 0, value: 10 },
      { guid: 'buy-cash', txGuid: 'tx-buy', postDate: '2023-01-10', description: 'Buy 10 AAPL', accountGuid: CASH, accountType: 'BANK', shares: -1_010, value: -1_010 },
    ];
    installBook([{ guid: 'lot-1', isClosed: 0 }]);
    getLatestPriceMock.mockResolvedValue({ value: 90 });
  });

  async function harvesting() {
    const response = await harvestingGET(
      new Request('http://localhost/api/reports/tax-harvesting?shortTermRate=0.37&longTermRate=0.2') as never,
    ) as unknown as Response;
    expect(response.status).toBe(200);
    return await response.json() as {
      candidates: Array<{ costBasis: number; marketValue: number; unrealizedLoss: number }>;
      summary: { totalHarvestableLoss: number };
      warnings: string[];
    };
  }

  it('quotes the harvestable loss NET of the buy commission', async () => {
    const body = await harvesting();

    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].costBasis).toBeCloseTo(1_010, 6);   // was 1_000
    expect(body.candidates[0].marketValue).toBeCloseTo(900, 6);
    expect(body.candidates[0].unrealizedLoss).toBeCloseTo(-110, 6); // was -100
    expect(body.summary.totalHarvestableLoss).toBeCloseTo(-110, 6);
  });

  it('classifies the fees against the FULL account paths and surfaces warnings', async () => {
    const body = await harvesting();

    expect(buildAccountPathMapMock).toHaveBeenCalledWith([ACCT, CASH, COMMISSIONS]);
    expect(body.warnings).toEqual([]);
  });

  it('loads the lots in ONE batch so the fee allocation runs once', async () => {
    await harvesting();

    // The lot engine issues exactly one lots.findMany and one fee query for
    // the whole book, not one pair per investment account.
    expect(prismaMock.lots.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.splits.findMany).toHaveBeenCalledTimes(1);
  });
});
