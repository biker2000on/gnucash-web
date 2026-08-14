/**
 * Lot Scrub — commission consistency with the money reports
 *
 * The scrub engine, the Investment Lots report (@/lib/lots) and Form 8949
 * (@/lib/reports/capital-gains) all describe the SAME sale. Once the two
 * reports started netting brokerage commissions (@/lib/trade-fees) and the
 * engine did not, one sale could be reported with three different numbers:
 * the ledger's Income:Capital Gains entry, the lots report's realized gain,
 * and the 8949 row.
 *
 * These tests drive the real scrub engine over an in-memory book and then ask
 * all three surfaces for the same sale, so a divergence fails here rather than
 * in a user's tax return.
 *
 * They also pin the refusals, which are the part a naive "net the fee"
 * change breaks:
 *  - a charge whose account path reads as interest is NEVER capitalized,
 *  - a sale is a sale on GROSS proceeds, so a fee equal to the proceeds
 *    cannot make a real disposal vanish along with its deduction,
 *  - a $0-value in-kind transfer still books no gain.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { FakePrisma, type Rec } from './helpers/fake-prisma';

// ---------------------------------------------------------------------------
// Mock modules
// ---------------------------------------------------------------------------

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../prisma', () => ({
  default: new Proxy({}, {
    get: (_t, prop) => {
      const db = (dbHolder as { current: any }).current;
      if (!db) throw new Error('Fake prisma not initialized');
      const v = db[prop as string];
      return typeof v === 'function' ? v.bind(db) : v;
    },
  }),
}));

vi.mock('../commodities', () => ({
  getLatestPrice: vi.fn().mockResolvedValue(null),
}));

import { autoAssignLots } from '../lot-assignment';
import { getAccountLots } from '../lots';
import { lotToRealizedSales } from '../reports/capital-gains';
import { loadTradeFees } from '../trade-fees';
import { buildAccountPathMap } from '../reports/utils';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const USD = 'usd-commodity-000000000000000000';
const AAPL = 'aapl-commodity-00000000000000000';
const ROOT = 'root-acct-guid-00000000000000000';
const ASSETS = 'assets-acct-guid-000000000000000';
const CASH = 'cash-acct-guid-00000000000000000';
const BROK_A = 'brok-a-acct-guid-000000000000000';
const BROK_B = 'brok-b-acct-guid-000000000000000';
const STOCK_A = 'stock-a-acct-guid-00000000000000';
const STOCK_B = 'stock-b-acct-guid-00000000000000';
const EXPENSES = 'expenses-acct-guid-0000000000000';
/** "Expenses:Commissions" — reads as a fee on its leaf AND on its full path. */
const COMMISSIONS = 'commissions-acct-guid-000000000';
/** "Expenses:Commissions:Schwab" — reads as a fee ONLY on its full path. */
const COMM_SCHWAB = 'comm-schwab-acct-guid-000000000';
const BROKERAGE_EXP = 'brokerage-exp-acct-guid-0000000';
/** "Expenses:Brokerage:Interest Fees" — accrued interest, never basis. */
const INTEREST_FEES = 'interest-fees-acct-guid-0000000';

function acct(guid: string, name: string, type: string, parent: string | null, commodity: string): Rec {
  return {
    guid, name, account_type: type, parent_guid: parent,
    commodity_guid: commodity, commodity_scu: 100, non_std_scu: 0,
    hidden: 0, placeholder: 0, code: '', description: '',
  };
}

let db: FakePrisma;

beforeEach(() => {
  db = new FakePrisma();
  (dbHolder as { current: any }).current = db;
});

/** Root, cash, two brokerages holding AAPL, and the expense chart. */
function seedBook() {
  db.t.books.push({ guid: 'book-1', root_account_guid: ROOT });
  db.t.commodities.push(
    { guid: USD, namespace: 'CURRENCY', mnemonic: 'USD', fraction: 100, quote_flag: 0 },
    { guid: AAPL, namespace: 'NASDAQ', mnemonic: 'AAPL', fraction: 10000, quote_flag: 1 },
  );
  db.t.accounts.push(
    acct(ROOT, 'Root Account', 'ROOT', null, USD),
    acct(ASSETS, 'Assets', 'ASSET', ROOT, USD),
    acct(CASH, 'Cash', 'BANK', ASSETS, USD),
    acct(BROK_A, 'Brokerage A', 'ASSET', ASSETS, USD),
    acct(STOCK_A, 'AAPL', 'STOCK', BROK_A, AAPL),
    acct(BROK_B, 'Brokerage B', 'ASSET', ASSETS, USD),
    acct(STOCK_B, 'AAPL', 'STOCK', BROK_B, AAPL),
    acct(EXPENSES, 'Expenses', 'EXPENSE', ROOT, USD),
    acct(COMMISSIONS, 'Commissions', 'EXPENSE', EXPENSES, USD),
    acct(COMM_SCHWAB, 'Schwab', 'EXPENSE', COMMISSIONS, USD),
    acct(BROKERAGE_EXP, 'Brokerage', 'EXPENSE', EXPENSES, USD),
    acct(INTEREST_FEES, 'Interest Fees', 'EXPENSE', BROKERAGE_EXP, USD),
  );
}

/** Add a balanced transaction. Splits: [splitGuid, accountGuid, qty, value]. */
function addTx(guid: string, date: string, splits: Array<[string, string, number, number]>) {
  db.t.transactions.push({
    guid, currency_guid: USD, num: '',
    post_date: new Date(date), enter_date: new Date(date), description: guid,
  });
  for (const [sg, acctGuid, qty, val] of splits) {
    db.t.splits.push({
      guid: sg, tx_guid: guid, account_guid: acctGuid,
      memo: '', action: '', reconcile_state: 'n', reconcile_date: null,
      value_num: BigInt(Math.round(val * 100)), value_denom: 100n,
      quantity_num: BigInt(Math.round(qty * 100)), quantity_denom: 100n,
      lot_guid: null,
    });
  }
}

// -- Query helpers over the fake DB -----------------------------------------

function split(guid: string): Rec {
  const s = db.t.splits.find(x => x.guid === guid);
  if (!s) throw new Error(`split not found: ${guid}`);
  return s;
}

function slotVal(objGuid: string, name: string): string | null {
  return db.t.slots.find(s => s.obj_guid === objGuid && s.name === name)?.string_val ?? null;
}

/** Value booked to the named capital-gains income account, as a decimal. */
function bookedGainsIncome(accountName: string): number {
  const account = db.t.accounts.find(a => a.name === accountName);
  if (!account) throw new Error(`gains account not created: ${accountName}`);
  const splits = db.t.splits.filter(s => s.account_guid === account.guid);
  return splits.reduce((sum, s) => sum + Number(s.value_num) / Number(s.value_denom), 0);
}

/** The lots report's realized gain for an account, fees included as the UI asks. */
async function lotsReportRealizedGain(accountGuid: string): Promise<number> {
  const accountPaths = await buildAccountPathMap();
  const lots = await getAccountLots(accountGuid, { includeTradeFees: true, accountPaths });
  return lots.reduce((sum, lot) => sum + lot.realizedGain, 0);
}

/** Form 8949's gain for an account: proceeds - cost basis over every sale row. */
async function form8949Gain(accountGuid: string): Promise<number> {
  const accountPaths = await buildAccountPathMap();
  const lots = await getAccountLots(accountGuid, { includeTradeFees: true, accountPaths });
  const { fees } = await loadTradeFees(
    lots.flatMap(lot => lot.splits.map(s => s.txGuid)),
    { accountPaths },
  );
  return lots
    .flatMap(lot => lotToRealizedSales(lot, 'AAPL', fees))
    .reduce((sum, sale) => sum + (sale.proceeds - sale.costBasis), 0);
}

// ---------------------------------------------------------------------------
// (a) Sell-side commission: the ledger must agree with both reports
// ---------------------------------------------------------------------------

describe('booked capital gains net the sell-side commission', () => {
  /**
   * Buy 100 @ $10 = $1,000 basis. Sell 100 for $1,490 gross with a $12
   * commission to "Expenses:Commissions" => $1,478 amount realized, $478 gain.
   * The engine used to book the GROSS $490.
   */
  function seedSaleWithSellCommission() {
    seedBook();
    addTx('tx-buy', '2022-01-10', [
      ['a-buy', STOCK_A, 100, 1000],
      ['a-buy-cash', CASH, -1000, -1000],
    ]);
    addTx('tx-sell', '2024-11-02', [
      ['a-sell', STOCK_A, -100, -1490],
      ['a-sell-cash', CASH, 1478, 1478],
      ['a-sell-comm', COMMISSIONS, 12, 12],
    ]);
  }

  it('books $478, the same figure the lots report and Form 8949 show', async () => {
    seedSaleWithSellCommission();

    const res = await autoAssignLots(STOCK_A, 'fifo');
    expect(res.gainsTransactions).toBe(1);

    // 1. The ledger: a $478 gain CREDITS the income account (native signs).
    expect(bookedGainsIncome('Long Term')).toBeCloseTo(-478, 6);
    expect(res.totalRealizedGain).toBeCloseTo(478, 6);

    // 2. The Investment Lots report.
    expect(await lotsReportRealizedGain(STOCK_A)).toBeCloseTo(478, 6);

    // 3. Form 8949.
    expect(await form8949Gain(STOCK_A)).toBeCloseTo(478, 6);

    // And all three are the SAME number, not merely each close to 478.
    const booked = -bookedGainsIncome('Long Term');
    expect(await lotsReportRealizedGain(STOCK_A)).toBeCloseTo(booked, 6);
    expect(await form8949Gain(STOCK_A)).toBeCloseTo(booked, 6);
  });

  it('leaves the gross $490 in the book only as the capitalized fee residual', async () => {
    seedSaleWithSellCommission();
    await autoAssignLots(STOCK_A, 'fifo');

    // The adjusting split carries the NET gain, so the security account keeps
    // a residual equal to the capitalized commission — the mirror of the $12
    // still sitting in Expenses:Commissions. Pinned so the trade-off is
    // deliberate rather than discovered.
    const stockValue = db.t.splits
      .filter(s => s.account_guid === STOCK_A)
      .reduce((sum, s) => sum + Number(s.value_num) / Number(s.value_denom), 0);
    expect(stockValue).toBeCloseTo(-12, 6);
  });

  it('nets a buy-side commission into basis on the same sale', async () => {
    // Buy $1,000 + $8 commission = $1,008 basis; sell $1,490 with a $12
    // commission = $1,478 realized => $470 gain on all three surfaces.
    seedBook();
    addTx('tx-buy', '2022-01-10', [
      ['a-buy', STOCK_A, 100, 1000],
      ['a-buy-comm', COMMISSIONS, 8, 8],
      ['a-buy-cash', CASH, -1008, -1008],
    ]);
    addTx('tx-sell', '2024-11-02', [
      ['a-sell', STOCK_A, -100, -1490],
      ['a-sell-cash', CASH, 1478, 1478],
      ['a-sell-comm', COMMISSIONS, 12, 12],
    ]);

    const res = await autoAssignLots(STOCK_A, 'fifo');

    expect(res.totalRealizedGain).toBeCloseTo(470, 6);
    expect(bookedGainsIncome('Long Term')).toBeCloseTo(-470, 6);
    expect(await lotsReportRealizedGain(STOCK_A)).toBeCloseTo(470, 6);
    expect(await form8949Gain(STOCK_A)).toBeCloseTo(470, 6);
  });
});

// ---------------------------------------------------------------------------
// (b) computeCarriedBasis classifies on the FULL account path
// ---------------------------------------------------------------------------

describe('carried basis includes commissions named for the broker', () => {
  /**
   * Buy 100 @ $10 with a $10 commission booked to
   * "Expenses:Commissions:Schwab" — a fee on its full path, unrecognized on
   * its bare leaf ("Schwab") — then transfer every share to Brokerage B and
   * sell there for $1,500.
   */
  function seedTransferOfAFeeBearingPurchase() {
    seedBook();
    addTx('tx-buy', '2022-01-10', [
      ['a-buy', STOCK_A, 100, 1000],
      ['a-buy-comm', COMM_SCHWAB, 10, 10],
      ['a-buy-cash', CASH, -1010, -1010],
    ]);
    addTx('tx-xfer', '2024-06-15', [
      ['a-out', STOCK_A, -100, -1000],
      ['b-in', STOCK_B, 100, 1000],
    ]);
    addTx('tx-sell', '2024-11-02', [
      ['b-sell', STOCK_B, -100, -1500],
      ['b-sell-cash', CASH, 1500, 1500],
    ]);
  }

  it('carries $1,010, not $1,000, across the transfer', async () => {
    seedTransferOfAFeeBearingPurchase();

    const resA = await autoAssignLots(STOCK_A, 'fifo');
    // Regression guard: a transfer-out is not a taxable event, fee or no fee.
    expect(resA.totalRealizedGain).toBeCloseTo(0, 6);
    expect(resA.gainsTransactions).toBe(0);
    // The destination lot (and its carried_basis) is written when Brokerage B
    // is scrubbed, so the slot only exists after both accounts have run.
    await autoAssignLots(STOCK_B, 'fifo');

    const bLot = split('b-in').lot_guid as string;
    // On the bare-leaf classifier this slot read "1000": the $10 was dropped.
    expect(slotVal(bLot, 'carried_basis')).toBe('1010');
  });

  it('turns the recovered $10 into a smaller gain agreeing with both reports', async () => {
    seedTransferOfAFeeBearingPurchase();

    await autoAssignLots(STOCK_A, 'fifo');
    const resB = await autoAssignLots(STOCK_B, 'fifo');

    // $1,500 proceeds - $1,010 basis = $490 (it was $500 while the fee was dropped).
    expect(resB.totalRealizedGain).toBeCloseTo(490, 6);
    expect(bookedGainsIncome('Long Term')).toBeCloseTo(-490, 6);
    expect(await lotsReportRealizedGain(STOCK_B)).toBeCloseTo(490, 6);
    expect(await form8949Gain(STOCK_B)).toBeCloseTo(490, 6);
  });
});

// ---------------------------------------------------------------------------
// Refusals that the fee netting must not erode
// ---------------------------------------------------------------------------

describe('charges that are NOT trade fees', () => {
  it('never capitalizes accrued interest booked to "Expenses:Brokerage:Interest Fees"', async () => {
    // Deny beats allow: the path reads as BOTH a fee and interest, so it is
    // ambiguous and left exactly where the user put it. The gain stays gross.
    seedBook();
    addTx('tx-buy', '2022-01-10', [
      ['a-buy', STOCK_A, 100, 1000],
      ['a-buy-cash', CASH, -1000, -1000],
    ]);
    addTx('tx-sell', '2024-11-02', [
      ['a-sell', STOCK_A, -100, -1490],
      ['a-sell-cash', CASH, 1465, 1465],
      ['a-sell-int', INTEREST_FEES, 25, 25],
    ]);

    const res = await autoAssignLots(STOCK_A, 'fifo');

    expect(res.totalRealizedGain).toBeCloseTo(490, 6);
    expect(bookedGainsIncome('Long Term')).toBeCloseTo(-490, 6);
    expect(await lotsReportRealizedGain(STOCK_A)).toBeCloseTo(490, 6);
    expect(await form8949Gain(STOCK_A)).toBeCloseTo(490, 6);
  });

  it('leaves an unrecognized charge alone rather than guessing', async () => {
    seedBook();
    db.t.accounts.push(acct('misc-acct-guid-00000000000000000', 'Misc', 'EXPENSE', EXPENSES, USD));
    addTx('tx-buy', '2022-01-10', [
      ['a-buy', STOCK_A, 100, 1000],
      ['a-buy-cash', CASH, -1000, -1000],
    ]);
    addTx('tx-sell', '2024-11-02', [
      ['a-sell', STOCK_A, -100, -1490],
      ['a-sell-cash', CASH, 1483, 1483],
      ['a-sell-misc', 'misc-acct-guid-00000000000000000', 7, 7],
    ]);

    const res = await autoAssignLots(STOCK_A, 'fifo');

    expect(res.totalRealizedGain).toBeCloseTo(490, 6);
    expect(await form8949Gain(STOCK_A)).toBeCloseTo(490, 6);
  });
});

describe('a fee never decides whether a disposal happened', () => {
  it('books the full loss when the commission equals the gross proceeds', async () => {
    // A near-worthless holding sold for $12 with a $12 commission. Gross
    // proceeds are $12, so this IS a sale; net proceeds are $0. A guard that
    // asked "are the proceeds zero?" of the NET figure would skip the booking
    // and silently delete a $1,000 capital loss.
    seedBook();
    addTx('tx-buy', '2022-01-10', [
      ['a-buy', STOCK_A, 100, 1000],
      ['a-buy-cash', CASH, -1000, -1000],
    ]);
    addTx('tx-sell', '2024-11-02', [
      ['a-sell', STOCK_A, -100, -12],
      ['a-sell-cash', CASH, 0, 0],
      ['a-sell-comm', COMMISSIONS, 12, 12],
    ]);

    const res = await autoAssignLots(STOCK_A, 'fifo');

    expect(res.gainsTransactions).toBe(1);
    expect(res.totalRealizedGain).toBeCloseTo(-1000, 6);
    // A loss DEBITS the income account (native signs).
    expect(bookedGainsIncome('Long Term')).toBeCloseTo(1000, 6);
    expect(await lotsReportRealizedGain(STOCK_A)).toBeCloseTo(-1000, 6);
    expect(await form8949Gain(STOCK_A)).toBeCloseTo(-1000, 6);
  });

  it('still books nothing for a genuinely unvalued $0 disposal', async () => {
    seedBook();
    addTx('tx-buy', '2022-01-10', [
      ['a-buy', STOCK_A, 100, 1000],
      ['a-buy-cash', CASH, -1000, -1000],
    ]);
    addTx('tx-sell', '2024-11-02', [
      ['a-sell', STOCK_A, -100, 0],
      ['a-sell-cash', CASH, 0, 0],
    ]);

    const res = await autoAssignLots(STOCK_A, 'fifo');

    expect(res.gainsTransactions).toBe(0);
    expect(res.totalRealizedGain).toBeCloseTo(0, 6);
  });

  it('books no gain on a $0-value in-kind transfer carrying an ACAT fee', async () => {
    // A transfer moves shares in BOTH directions on one ticket, so the
    // allocator refuses to attribute the fee at all — and a transfer is not a
    // taxable event either way.
    seedBook();
    addTx('tx-buy', '2022-01-10', [
      ['a-buy', STOCK_A, 100, 1000],
      ['a-buy-cash', CASH, -1000, -1000],
    ]);
    addTx('tx-xfer', '2024-06-15', [
      ['a-out', STOCK_A, -100, 0],
      ['b-in', STOCK_B, 100, 0],
      ['xfer-fee', COMMISSIONS, 75, 75],
      ['xfer-cash', CASH, -75, -75],
    ]);

    const resA = await autoAssignLots(STOCK_A, 'fifo');
    const resB = await autoAssignLots(STOCK_B, 'fifo');

    expect(resA.gainsTransactions).toBe(0);
    expect(resA.totalRealizedGain).toBeCloseTo(0, 6);
    expect(resB.gainsTransactions).toBe(0);
    // The purchase basis travels intact; the unattributable ACAT fee does not
    // leak into it.
    const bLot = split('b-in').lot_guid as string;
    expect(slotVal(bLot, 'carried_basis')).toBe('1000');
  });
});
