/**
 * Investment Lots vs. Form 8949 — the two reports must agree on the same sale.
 *
 * A brokerage commission is a separate EXPENSE split of the trade transaction,
 * invisible to the lot's own splits. The capital-gains path recovers it and
 * applies the IRS treatment (basis up on the buy, proceeds down on the sell);
 * until this change the lot engine did not, so the Investment Lots report and
 * Form 8949 reported gains for the SAME sale that differed by the commission.
 *
 * These tests drive BOTH production paths from ONE mocked book:
 *   - Investment Lots:  getAccountLots(..., { includeTradeFees: true })
 *   - Form 8949:        lotToRealizedSales(lot, ticker, loadTradeFees(...))
 * and assert the figures match. They also pin the pre-fix numbers, so the
 * disagreement itself is a documented assertion rather than a memory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLotsFindMany = vi.fn();
const mockSlotsFindMany = vi.fn();
const mockAccountsFindMany = vi.fn();
const mockSplitsFindMany = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    lots: { findMany: (...a: unknown[]) => mockLotsFindMany(...a) },
    slots: { findMany: (...a: unknown[]) => mockSlotsFindMany(...a) },
    accounts: { findMany: (...a: unknown[]) => mockAccountsFindMany(...a) },
    splits: { findMany: (...a: unknown[]) => mockSplitsFindMany(...a) },
  },
}));

vi.mock('../commodities', () => ({
  getLatestPrice: vi.fn(async () => null),
}));

import { getAccountLots, type LotSummary } from '../lots';
import { loadTradeFees } from '../trade-fees';
import { lotToRealizedSales } from '../reports/capital-gains';

const ACCT = 'acct-stock';
const COMMODITY = 'commodity-aapl';
const CASH = 'acct-cash';
const COMMISSIONS = 'acct-commissions';
const TICKER = 'AAPL';

const ACCOUNT_PATHS = new Map([
  [ACCT, 'Assets:Investments:Brokerage:AAPL'],
  [CASH, 'Assets:Investments:Brokerage:Cash'],
  [COMMISSIONS, 'Expenses:Investments:Commissions'],
]);

/** One split of the fixture book, in human terms. */
interface FixtureSplit {
  guid: string;
  txGuid: string;
  postDate: string;
  description: string;
  accountGuid: string;
  accountType: 'STOCK' | 'EXPENSE' | 'BANK';
  shares: number;
  value: number;
  /** Lot the split belongs to (security splits only). */
  lotGuid?: string;
}

const qty = (shares: number) => BigInt(Math.round(shares * 10_000));
const cents = (value: number) => BigInt(Math.round(value * 100));

/** All splits of the fixture book, whatever transaction they belong to. */
let book: FixtureSplit[] = [];

/** Shape prisma.lots.findMany returns (lot splits + their tx siblings). */
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

/** Shape prisma.splits.findMany returns for the trade-fee loader. */
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

/** Install `book` as the mocked database, with the given lot layout. */
function installBook(lots: Array<{ guid: string; isClosed: 0 | 1 }>) {
  mockLotsFindMany.mockResolvedValue(lots.map(l => ({
    guid: l.guid,
    account_guid: ACCT,
    is_closed: l.isClosed,
    splits: book.filter(s => s.lotGuid === l.guid).map(lotSplitRow),
  })));
  mockSplitsFindMany.mockImplementation(async (args: { where: { tx_guid: { in: string[] } } }) => {
    const wanted = new Set(args.where.tx_guid.in);
    return book.filter(s => wanted.has(s.txGuid)).map(feeQueryRow);
  });
}

/** The Form 8949 path, run over the same book the lot report reads. */
async function form8949(lot: LotSummary) {
  const { fees } = await loadTradeFees(
    lot.splits.map(s => s.txGuid),
    { accountPaths: ACCOUNT_PATHS },
  );
  const sales = lotToRealizedSales(lot, TICKER, fees);
  return {
    sales,
    proceeds: sales.reduce((sum, s) => sum + s.proceeds, 0),
    costBasis: sales.reduce((sum, s) => sum + s.costBasis, 0),
    gain: sales.reduce((sum, s) => sum + s.proceeds - s.costBasis, 0),
  };
}

beforeEach(() => {
  book = [];
  mockLotsFindMany.mockReset();
  mockSplitsFindMany.mockReset().mockResolvedValue([]);
  mockSlotsFindMany.mockReset().mockResolvedValue([]);
  mockAccountsFindMany.mockReset().mockResolvedValue([
    { guid: ACCT, commodity_guid: COMMODITY },
  ]);
});

describe('a sale with commissions on both sides', () => {
  /**
   * Buy 10 AAPL for $1,000 with a $10 commission (2023-01-10).
   * Sell all 10 for $1,500 with a $12 commission (2024-06-20).
   *
   * IRS (Pub. 550): basis $1,000 + $10 = $1,010; amount realized
   * $1,500 - $12 = $1,488; gain $478 — NOT the gross $500.
   */
  beforeEach(() => {
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

  it('BEFORE: the gross lot figures disagree with Form 8949 by the commissions', async () => {
    // Exactly what the lot engine returns when it is not fee-aware — the state
    // that shipped, and what every caller that does not opt in still gets.
    const [gross] = await getAccountLots(ACCT);
    const tax = await form8949(gross);

    // Investment Lots (gross):     basis $1,000.00   gain $500.00
    expect(gross.totalCost).toBeCloseTo(1_000, 6);
    expect(gross.realizedGain).toBeCloseTo(500, 6);
    // Form 8949 (net of fees):     basis $1,010.00   proceeds $1,488.00   gain $478.00
    expect(tax.costBasis).toBeCloseTo(1_010, 6);
    expect(tax.proceeds).toBeCloseTo(1_488, 6);
    expect(tax.gain).toBeCloseTo(478, 6);
    // Two screens, one sale, $22.00 apart — the $10 buy + $12 sell commission.
    expect(gross.realizedGain - tax.gain).toBeCloseTo(22, 6);
    expect(gross.totalCost - tax.costBasis).toBeCloseTo(-10, 6);
  });

  it('AFTER: the fee-aware lot figures MATCH Form 8949 exactly', async () => {
    const [net] = await getAccountLots(ACCT, {
      includeTradeFees: true,
      accountPaths: ACCOUNT_PATHS,
    });
    const tax = await form8949(net);

    // Investment Lots: basis $1,010.00, realized gain $478.00
    expect(net.totalCost).toBeCloseTo(1_010, 6);
    expect(net.realizedGain).toBeCloseTo(478, 6);
    // Form 8949:       basis $1,010.00, proceeds $1,488.00, gain $478.00
    expect(tax.costBasis).toBeCloseTo(1_010, 6);
    expect(tax.gain).toBeCloseTo(478, 6);
    // The agreement itself, which is the point:
    expect(net.totalCost).toBeCloseTo(tax.costBasis, 6);
    expect(net.realizedGain).toBeCloseTo(tax.gain, 6);
    // Both commissions reached the figures, once each.
    expect(net.tradeFees).toBeCloseTo(22, 6);
  });

  it('reports the commissions on a partially-sold lot the same way', async () => {
    // Same buy ($1,000 + $10 fee = $101.00/share over 10 shares), but only 4
    // shares sold for $600 with a $12 commission.
    //   Investment Lots: realized = ($600 - $12) - 4 * $101 = $184.00
    //   Form 8949:       proceeds $588.00, basis $404.00, gain $184.00
    book.find(s => s.guid === 'sell')!.shares = -4;
    book.find(s => s.guid === 'sell')!.value = -600;
    installBook([{ guid: 'lot-1', isClosed: 0 }]);

    const [net] = await getAccountLots(ACCT, {
      includeTradeFees: true,
      accountPaths: ACCOUNT_PATHS,
    });
    const tax = await form8949(net);

    expect(net.realizedGain).toBeCloseTo(184, 6);
    expect(tax.proceeds).toBeCloseTo(588, 6);
    expect(tax.costBasis).toBeCloseTo(404, 6);
    expect(net.realizedGain).toBeCloseTo(tax.gain, 6);
    // The unsold 6 shares keep the rest of the buy commission in their basis:
    // total basis $1,010.00 less the $404.00 attributed to the sold shares.
    expect(net.totalCost).toBeCloseTo(1_010, 6);
  });
});

describe('a scrubbed sell split across two lots', () => {
  /**
   * ONE sell ticket, scrubbed into one security split per lot — the shape the
   * lot-scrub engine produces. The $20 ticket commission must be charged ONCE
   * in total, apportioned by value, not $20 against each lot.
   *
   * Lot A: bought 10 @ $100 = $1,000. Lot B: bought 10 @ $50 = $500.
   * Sold: 10 shares from each for $900 apiece; $20 commission on the ticket.
   *   fee share (equal $900 weights): $10 to each leg
   *   Lot A realized = ($900 - $10) - $1,000 = -$110.00
   *   Lot B realized = ($900 - $10) -   $500 =  $390.00
   */
  beforeEach(() => {
    book = [
      { guid: 'buy-a', txGuid: 'tx-buy-a', postDate: '2023-01-10', description: 'Buy A', accountGuid: ACCT, accountType: 'STOCK', shares: 10, value: 1_000, lotGuid: 'lot-a' },
      { guid: 'buy-b', txGuid: 'tx-buy-b', postDate: '2023-02-10', description: 'Buy B', accountGuid: ACCT, accountType: 'STOCK', shares: 10, value: 500, lotGuid: 'lot-b' },
      { guid: 'sell-a', txGuid: 'tx-sell', postDate: '2024-06-20', description: 'Sell 20 AAPL', accountGuid: ACCT, accountType: 'STOCK', shares: -10, value: -900, lotGuid: 'lot-a' },
      { guid: 'sell-b', txGuid: 'tx-sell', postDate: '2024-06-20', description: 'Sell 20 AAPL', accountGuid: ACCT, accountType: 'STOCK', shares: -10, value: -900, lotGuid: 'lot-b' },
      { guid: 'sell-fee', txGuid: 'tx-sell', postDate: '2024-06-20', description: 'Sell 20 AAPL', accountGuid: COMMISSIONS, accountType: 'EXPENSE', shares: 0, value: 20 },
      { guid: 'sell-cash', txGuid: 'tx-sell', postDate: '2024-06-20', description: 'Sell 20 AAPL', accountGuid: CASH, accountType: 'BANK', shares: 1_780, value: 1_780 },
    ];
    installBook([{ guid: 'lot-a', isClosed: 1 }, { guid: 'lot-b', isClosed: 1 }]);
  });

  it('charges the ticket commission once in total, and agrees with Form 8949 per lot', async () => {
    const lots = await getAccountLots(ACCT, {
      includeTradeFees: true,
      accountPaths: ACCOUNT_PATHS,
    });
    const byGuid = new Map(lots.map(l => [l.guid, l]));
    const lotA = byGuid.get('lot-a')!;
    const lotB = byGuid.get('lot-b')!;

    expect(lotA.realizedGain).toBeCloseTo(-110, 6);
    expect(lotB.realizedGain).toBeCloseTo(390, 6);

    const taxA = await form8949(lotA);
    const taxB = await form8949(lotB);
    expect(taxA.proceeds).toBeCloseTo(890, 6);
    expect(taxB.proceeds).toBeCloseTo(890, 6);
    expect(lotA.realizedGain).toBeCloseTo(taxA.gain, 6);
    expect(lotB.realizedGain).toBeCloseTo(taxB.gain, 6);

    // Charged once: $20.00 across both lots, not $20.00 per lot. Against the
    // gross figures (-$100 and +$400) the total gain drops by exactly $20.00.
    expect((lotA.tradeFees ?? 0) + (lotB.tradeFees ?? 0)).toBeCloseTo(20, 6);
    expect(lotA.realizedGain + lotB.realizedGain).toBeCloseTo(-100 + 400 - 20, 6);
  });
});

describe('conservatism: an unclassified charge changes nothing', () => {
  const AMBIGUOUS = 'acct-ambiguous';
  const UNRECOGNIZED = 'acct-unrecognized';
  const NOT_A_FEE = 'acct-accrued';

  /** Gross baseline for the fixture below: basis $1,000, gain $500. */
  function tradeWith(chargeAccount: string) {
    book = [
      { guid: 'buy', txGuid: 'tx-buy', postDate: '2023-01-10', description: 'Buy 10 AAPL', accountGuid: ACCT, accountType: 'STOCK', shares: 10, value: 1_000, lotGuid: 'lot-1' },
      { guid: 'sell', txGuid: 'tx-sell', postDate: '2024-06-20', description: 'Sell 10 AAPL', accountGuid: ACCT, accountType: 'STOCK', shares: -10, value: -1_500, lotGuid: 'lot-1' },
      { guid: 'charge', txGuid: 'tx-sell', postDate: '2024-06-20', description: 'Sell 10 AAPL', accountGuid: chargeAccount, accountType: 'EXPENSE', shares: 0, value: 12 },
    ];
    installBook([{ guid: 'lot-1', isClosed: 1 }]);
  }

  const paths = new Map([
    ...ACCOUNT_PATHS,
    // Reads as BOTH a fee and a non-fee charge -> 'ambiguous'.
    [AMBIGUOUS, 'Expenses:Investments:Transaction Tax Fee'],
    // Reads as neither -> 'unrecognized'.
    [UNRECOGNIZED, 'Expenses:Investments:Sundry Charge'],
    // Confidently not basis -> 'not-fee', and silent.
    [NOT_A_FEE, 'Expenses:Investments:Accrued Interest'],
  ]);

  it('an AMBIGUOUS charge is left out of basis and proceeds, and is reported', async () => {
    tradeWith(AMBIGUOUS);
    const feeWarnings: string[] = [];

    const [lot] = await getAccountLots(ACCT, {
      includeTradeFees: true,
      accountPaths: paths,
      feeWarnings,
    });

    // Identical to the gross figures: nothing was guessed at.
    expect(lot.totalCost).toBeCloseTo(1_000, 6);
    expect(lot.realizedGain).toBeCloseTo(500, 6);
    expect(lot.tradeFees).toBeCloseTo(0, 6);
    // ...but the user is told, rather than silently reported $12 short.
    expect(feeWarnings).toHaveLength(1);
    expect(feeWarnings[0]).toContain('Transaction Tax Fee');
    expect(feeWarnings[0]).toContain('NOT added to cost basis');
  });

  it('an UNRECOGNIZED charge is left out of basis and proceeds, and is reported', async () => {
    tradeWith(UNRECOGNIZED);
    const feeWarnings: string[] = [];

    const [lot] = await getAccountLots(ACCT, {
      includeTradeFees: true,
      accountPaths: paths,
      feeWarnings,
    });

    expect(lot.totalCost).toBeCloseTo(1_000, 6);
    expect(lot.realizedGain).toBeCloseTo(500, 6);
    expect(lot.tradeFees).toBeCloseTo(0, 6);
    expect(feeWarnings).toHaveLength(1);
    expect(feeWarnings[0]).toContain('Sundry Charge');
    expect(feeWarnings[0]).toContain('not recognized as a commission');
  });

  it('a NOT-A-FEE charge (accrued interest) is left out silently', async () => {
    tradeWith(NOT_A_FEE);
    const feeWarnings: string[] = [];

    const [lot] = await getAccountLots(ACCT, {
      includeTradeFees: true,
      accountPaths: paths,
      feeWarnings,
    });

    expect(lot.totalCost).toBeCloseTo(1_000, 6);
    expect(lot.realizedGain).toBeCloseTo(500, 6);
    expect(feeWarnings).toEqual([]);
  });

  it('each refusal keeps the lot report and Form 8949 in agreement', async () => {
    // The conservatism is only safe if BOTH reports refuse the same charge.
    for (const account of [AMBIGUOUS, UNRECOGNIZED, NOT_A_FEE]) {
      tradeWith(account);
      const [lot] = await getAccountLots(ACCT, { includeTradeFees: true, accountPaths: paths });
      const { fees } = await loadTradeFees(['tx-buy', 'tx-sell'], { accountPaths: paths });
      const sales = lotToRealizedSales(lot, TICKER, fees);
      const gain = sales.reduce((sum, s) => sum + s.proceeds - s.costBasis, 0);
      expect(lot.realizedGain).toBeCloseTo(gain, 6);
      expect(lot.realizedGain).toBeCloseTo(500, 6);
    }
  });
});

describe('callers that do not opt in are unchanged', () => {
  it('never queries the trade-fee splits and reports gross figures', async () => {
    book = [
      { guid: 'buy', txGuid: 'tx-buy', postDate: '2023-01-10', description: 'Buy 10 AAPL', accountGuid: ACCT, accountType: 'STOCK', shares: 10, value: 1_000, lotGuid: 'lot-1' },
      { guid: 'buy-fee', txGuid: 'tx-buy', postDate: '2023-01-10', description: 'Buy 10 AAPL', accountGuid: COMMISSIONS, accountType: 'EXPENSE', shares: 0, value: 10 },
    ];
    installBook([{ guid: 'lot-1', isClosed: 0 }]);

    const [lot] = await getAccountLots(ACCT);

    expect(lot.totalCost).toBeCloseTo(1_000, 6);
    expect(lot.tradeFees).toBeCloseTo(0, 6);
    expect(mockSplitsFindMany).not.toHaveBeenCalled();
  });
});
