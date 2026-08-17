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

/**
 * Hook for making the engine's FRESHLY GENERATED guids deterministic.
 *
 * Null for every test here but the residual-stability one, which needs the
 * sub-split guids it produces to be chosen rather than random — see
 * `installOrderedSubSplitGuids`. Everything else gets the real random generator.
 */
const guidHolder = vi.hoisted(() => ({ next: null as null | (() => string) }));

vi.mock('../gnucash', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gnucash')>();
  return {
    ...actual,
    generateGuid: () => (guidHolder.next ? guidHolder.next() : actual.generateGuid()),
  };
});

import { apportionCarriedBasis } from '../lot-scrub';
import { autoAssignLots, revertScrubRun } from '../lot-assignment';
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
  // Real random guids unless a test opts in.
  guidHolder.next = null;
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
// (c) A commission is conserved across partial transfers
// ---------------------------------------------------------------------------

/** A `carried_basis` slot as an exact integer count of millionths. */
function carriedBasisUnits(lotGuid: string): number {
  const raw = slotVal(lotGuid, 'carried_basis');
  if (raw === null) throw new Error(`no carried_basis slot on lot ${lotGuid}`);
  return Math.round(parseFloat(raw) * 1e6);
}

describe('carried basis is conserved across partial transfers', () => {
  /**
   * Buy 3 shares for $1,000.00 plus a $0.01 commission — $1,000.01 of basis
   * that does NOT divide evenly by three — then move them out ONE AT A TIME so
   * each share lands in its own destination lot, and sell all three there.
   *
   * Rounding every lot's own $333.33666666... slice independently stored
   * $333.336667 three times: $1,000.010001 of basis against the $1,000.01
   * actually paid, and a gain short by the difference. The apportionment
   * rounds the CUMULATIVE allocation instead, so the slices telescope back to
   * the source basis exactly.
   */
  function seedShareByShareTransfer() {
    seedBook();
    addTx('tx-buy', '2022-01-10', [
      ['a-buy', STOCK_A, 3, 1000],
      ['a-buy-comm', COMMISSIONS, 0.01, 0.01],
      ['a-buy-cash', CASH, -1000.01, -1000.01],
    ]);
    for (const [i, date] of ['2024-06-15', '2024-06-16', '2024-06-17'].entries()) {
      addTx(`tx-xfer-${i}`, date, [
        [`a-out-${i}`, STOCK_A, -1, 0],
        [`b-in-${i}`, STOCK_B, 1, 0],
      ]);
    }
    addTx('tx-sell', '2024-11-02', [
      ['b-sell', STOCK_B, -3, -3000],
      ['b-sell-cash', CASH, 3000, 3000],
    ]);
  }

  it('spreads $1,000.01 over three one-share lots that sum back to $1,000.01', async () => {
    seedShareByShareTransfer();

    await autoAssignLots(STOCK_A, 'fifo');
    await autoAssignLots(STOCK_B, 'fifo');

    const destLots = [0, 1, 2].map(i => split(`b-in-${i}`).lot_guid as string);
    expect(new Set(destLots).size).toBe(3);

    const stored = destLots.map(carriedBasisUnits);
    // Integer millionths, so this is an EXACT conservation check: independent
    // per-lot rounding stores 333336667 three times and overshoots by 1.
    expect(stored.reduce((sum, units) => sum + units, 0)).toBe(1_000_010_000);
    expect([...stored].sort((a, b) => a - b)).toEqual([333_336_666, 333_336_667, 333_336_667]);
  });

  it('realizes $1,999.99 on the sale, on all three surfaces', async () => {
    seedShareByShareTransfer();

    await autoAssignLots(STOCK_A, 'fifo');
    const resB = await autoAssignLots(STOCK_B, 'fifo');

    // $3,000 proceeds - $1,000.01 basis. Duplicating the commission across the
    // three lots reported $1,999.989999.
    expect(resB.totalRealizedGain).toBeCloseTo(1999.99, 6);
    expect(await lotsReportRealizedGain(STOCK_B)).toBeCloseTo(1999.99, 6);
    expect(await form8949Gain(STOCK_B)).toBeCloseTo(1999.99, 6);
  });
});

// ---------------------------------------------------------------------------
// (d) Conservation survives a BACKDATED transfer
// ---------------------------------------------------------------------------

describe('carried basis is conserved when an outflow is inserted out of order', () => {
  /**
   * The same $1,000.01 over three shares, but the three transfers are not
   * entered in date order: 15 June and 17 June are booked and scrubbed first,
   * and only then is the missed 16 June transfer entered and the book
   * re-scrubbed. That is ordinary bookkeeping, and it is what a
   * compute-once-per-transfer apportionment cannot survive:
   *
   *   - the first pass hands 15 June cum(1) = 333.336667 and 17 June
   *     cum(2) - cum(1) = 333.336666;
   *   - the backdated 16 June transfer now sits BETWEEN them, so it is handed
   *     cum(2) - cum(1) = 333.336666 as well;
   *   - stored total 1,000.009999 against the $1,000.01 actually paid, and the
   *     eventual full sale reports $1,999.990001 instead of $1,999.99.
   *
   * The slices are therefore never final: every pass that can have changed a
   * lot's outflow set re-derives all of them
   * (reconcileCarriedBasisForSourceLots).
   */
  function seedTwoOfThreeTransfers() {
    seedBook();
    addTx('tx-buy', '2022-01-10', [
      ['a-buy', STOCK_A, 3, 1000],
      ['a-buy-comm', COMMISSIONS, 0.01, 0.01],
      ['a-buy-cash', CASH, -1000.01, -1000.01],
    ]);
    addTx('tx-xfer-a', '2024-06-15', [['a-out-a', STOCK_A, -1, 0], ['b-in-a', STOCK_B, 1, 0]]);
    addTx('tx-xfer-c', '2024-06-17', [['a-out-c', STOCK_A, -1, 0], ['b-in-c', STOCK_B, 1, 0]]);
  }

  /** The missed middle transfer, entered after the first scrub. */
  function addBackdatedTransfer() {
    addTx('tx-xfer-b', '2024-06-16', [['a-out-b', STOCK_A, -1, 0], ['b-in-b', STOCK_B, 1, 0]]);
  }

  it('re-apportions the slices already stored, so the stored total stays exact', async () => {
    seedTwoOfThreeTransfers();
    await autoAssignLots(STOCK_A, 'fifo');
    await autoAssignLots(STOCK_B, 'fifo');

    // First pass: 15 June leads, 17 June follows and carries the smaller slice.
    expect(carriedBasisUnits(split('b-in-a').lot_guid as string)).toBe(333_336_667);
    expect(carriedBasisUnits(split('b-in-c').lot_guid as string)).toBe(333_336_666);

    addBackdatedTransfer();
    await autoAssignLots(STOCK_A, 'fifo');
    await autoAssignLots(STOCK_B, 'fifo');

    const destLots = ['b-in-a', 'b-in-b', 'b-in-c'].map(g => split(g).lot_guid as string);
    expect(new Set(destLots).size).toBe(3);

    // 17 June is no longer the second outflow — it is the third, and DRAINS
    // the lot. Its stored slice must have been rewritten from 333,336,666.
    // Without that rewrite the three slices sum to 1,000,009,999.
    expect(carriedBasisUnits(destLots[2])).toBe(333_336_667);
    expect(destLots.map(carriedBasisUnits)).toEqual([333_336_667, 333_336_666, 333_336_667]);
    expect(destLots.reduce((sum, lot) => sum + carriedBasisUnits(lot), 0)).toBe(1_000_010_000);
  });

  it('realizes the full $1,999.99 on the later sale, on all three surfaces', async () => {
    seedTwoOfThreeTransfers();
    await autoAssignLots(STOCK_A, 'fifo');
    await autoAssignLots(STOCK_B, 'fifo');

    addBackdatedTransfer();
    addTx('tx-sell', '2024-11-02', [
      ['b-sell', STOCK_B, -3, -3000],
      ['b-sell-cash', CASH, 3000, 3000],
    ]);
    await autoAssignLots(STOCK_A, 'fifo');
    const resB = await autoAssignLots(STOCK_B, 'fifo');

    // $3,000 proceeds - $1,000.01 basis, to the millionth. The drifted book
    // reported $1,999.990001 here.
    expect(Math.round(resB.totalRealizedGain * 1e6)).toBe(1_999_990_000);
    expect(await lotsReportRealizedGain(STOCK_B)).toBeCloseTo(1999.99, 6);
    expect(await form8949Gain(STOCK_B)).toBeCloseTo(1999.99, 6);
    // The ledger posts each lot's gain in the book currency's cents, so three
    // lots of $666.663333 book $1,999.98 — a rounding of the conserved figure
    // above, not a loss of basis. Pinned so the two are not confused.
    expect(-bookedGainsIncome('Long Term')).toBeCloseTo(1999.98, 6);
  });
});

// ---------------------------------------------------------------------------
// (e) The residual does not move when the book is re-scrubbed
// ---------------------------------------------------------------------------

describe('residual assignment is stable across revert and re-scrub', () => {
  /**
   * Three transfers leave the $1,000.01 lot on the SAME day, so the order
   * among them — and with it which destination lot receives the residual
   * millionth — is decided entirely by the tiebreak.
   *
   * Two of the three outflows are sub-splits the engine CARVED from a transfer
   * that spanned several lots, and a revert-and-re-scrub carves them again
   * with freshly generated GUIDs. A guid tiebreak therefore reshuffles them on
   * every run: sell one specific destination lot and its taxable gain depends
   * on how many times the book has been scrubbed. The order is keyed on the
   * transaction instead (orderLotOutflows), which the engine never
   * regenerates.
   *
   * The rounds are compared to each other AND to the documented expectation,
   * so this fails both if the result drifts and if it settles on the wrong lot.
   */
  /**
   * The two surviving splits are named to start with '7' and '8' on purpose:
   * under a guid tiebreak a sub-split guid can land before both, between them,
   * or after both, and these two names make each of those a DIFFERENT residual
   * assignment that the round-to-round comparison below can see. Readable names
   * alone ("a-out-…") would sort every sub-split into one bucket.
   */
  const OUT_X2 = '7-a-out-x2-guid-00000000000000';
  const OUT_X3 = '8-a-out-x3-guid-00000000000000';

  /**
   * The guid prefix the engine's generated splits get in each round, chosen so
   * a guid-keyed order MUST disagree between rounds 0 and 1.
   *
   * This is what makes the test a deterministic negative control instead of a
   * probabilistic one. Left to the real random generator, a regenerated
   * sub-split guid lands before OUT_X2, between the two, or after OUT_X3 with
   * some probability each — so a tree with the broken guid-keyed order still
   * produced identical rounds roughly one run in eight, and a test that goes
   * green one run in eight on a broken tree eventually goes green on a broken
   * tree. Pinning the prefix removes the coin flip: '0' sorts below OUT_X2 and
   * 'f' sorts above OUT_X3, so under a guid key round 0 puts the sub-split
   * FIRST among the lot's outflows and round 1 puts it LAST, which moves the
   * residual millionth between destination lots every single run.
   *
   * Under the shipped order the prefix is irrelevant — the key is the outflow's
   * tx_guid, which no round regenerates — so all four rounds agree.
   */
  const ROUND_GUID_PREFIXES = ['0', 'f', '0', 'f'] as const;

  /**
   * Makes every guid the engine generates deterministic: `<prefix><counter>`,
   * 32 chars wide like a real one. The counter never resets, so guids stay
   * unique across rounds while the prefix decides where the round's sub-splits
   * fall in a guid-keyed sort.
   */
  function installOrderedSubSplitGuids(): (prefix: string) => void {
    let counter = 0;
    let prefix: string = ROUND_GUID_PREFIXES[0];
    guidHolder.next = () => `${prefix}${String(counter++).padStart(31, '0')}`;
    return (next: string) => { prefix = next; };
  }

  function seedSameDayTransfersOutOfThreeLots() {
    seedBook();
    // One small early lot, then the lot whose basis does not divide evenly.
    addTx('tx-buy-1', '2022-01-05', [
      ['a-buy-1', STOCK_A, 1, 500], ['a-buy-1-cash', CASH, -500, -500],
    ]);
    addTx('tx-buy-2', '2022-02-10', [
      ['a-buy-2', STOCK_A, 3, 1000],
      ['a-buy-2-comm', COMMISSIONS, 0.01, 0.01],
      ['a-buy-2-cash', CASH, -1000.01, -1000.01],
    ]);
    // x1 spans the early lot AND the $1,000.01 lot, so its leg into the
    // $1,000.01 lot is a sub-split the engine carves fresh on every scrub.
    // x2 and x3 fit in one lot, so they keep the user's own split guids.
    addTx('tx-x1', '2024-06-15', [['a-out-1', STOCK_A, -2, 0], ['b-in-1', STOCK_B, 2, 0]]);
    addTx('tx-x2', '2024-06-15', [[OUT_X2, STOCK_A, -1, 0], ['b-in-2', STOCK_B, 1, 0]]);
    addTx('tx-x3', '2024-06-15', [[OUT_X3, STOCK_A, -1, 0], ['b-in-3', STOCK_B, 1, 0]]);
    addTx('tx-sell', '2024-11-02', [
      ['b-sell', STOCK_B, -4, -4000],
      ['b-sell-cash', CASH, 4000, 4000],
    ]);
  }

  /** The transfer a destination lot's shares arrived on. */
  function transferOfLot(lotGuid: string): string {
    const arrival = db.t.splits.find(
      s => s.lot_guid === lotGuid && Number(s.quantity_num) > 0,
    );
    return arrival?.tx_guid ?? 'unknown';
  }

  /** Every destination lot as "<transfer>:<carried basis in millionths>". */
  function basisByTransfer(): string[] {
    return db.t.lots
      .filter(l => l.account_guid === STOCK_B)
      .map(l => {
        const raw = slotVal(l.guid, 'carried_basis');
        return `${transferOfLot(l.guid)}:${raw === null ? 'none' : Math.round(parseFloat(raw) * 1e6)}`;
      })
      .sort();
  }

  /** Every destination lot as "<transfer>:<realized gain in millionths>". */
  async function gainByTransfer(): Promise<string[]> {
    const accountPaths = await buildAccountPathMap();
    const lots = await getAccountLots(STOCK_B, { includeTradeFees: true, accountPaths });
    return lots
      .map(lot => `${transferOfLot(lot.guid)}:${Math.round(lot.realizedGain * 1e6)}`)
      .sort();
  }

  it('gives the residual millionth to the same lot, and the same gain, every scrub', async () => {
    seedSameDayTransfersOutOfThreeLots();
    const setRoundPrefix = installOrderedSubSplitGuids();

    const rounds: Array<{ basis: string[]; gains: string[]; total: number }> = [];
    const ROUNDS = ROUND_GUID_PREFIXES.length;
    for (let round = 0; round < ROUNDS; round++) {
      // Alternates the guid prefix so a guid-keyed order cannot agree with
      // itself between rounds. See ROUND_GUID_PREFIXES.
      setRoundPrefix(ROUND_GUID_PREFIXES[round]);
      const resA = await autoAssignLots(STOCK_A, 'fifo');
      const resB = await autoAssignLots(STOCK_B, 'fifo');

      rounds.push({
        basis: basisByTransfer(),
        gains: await gainByTransfer(),
        total: Math.round(resB.totalRealizedGain * 1e6),
      });

      if (round < ROUNDS - 1) {
        await revertScrubRun(resB.runId);
        await revertScrubRun(resA.runId);
      }
    }

    // Every re-scrub reproduces the first one exactly — same lot, same gain.
    for (let round = 1; round < ROUNDS; round++) {
      expect(rounds[round]).toEqual(rounds[0]);
    }

    // And it settles where the documented order says it should: the outflows
    // of the $1,000.01 lot run tx-x1, tx-x2, tx-x3, so tx-x2's destination lot
    // holds the short slice and tx-x3's drains the lot.
    expect(rounds[0].basis).toEqual([
      'tx-x1:333336667',
      'tx-x1:500000000',
      'tx-x2:333336666',
      'tx-x3:333336667',
    ]);
    // $4,000 proceeds - ($500 + $1,000.01) of basis, conserved exactly.
    expect(rounds[0].total).toBe(2_499_990_000);
  });
});

// ---------------------------------------------------------------------------
// (f) A transfer chain LONGER than any plausible hop cap
// ---------------------------------------------------------------------------

describe('carried basis propagates the whole length of a transfer chain', () => {
  /**
   * reconcileCarriedBasisForSourceLots walks from a rewritten lot to the lots
   * that carry ITS basis onward, and it used to stop after 25 hops.
   *
   * A depth cap there is not a safety net, it is a silent wrong answer. The
   * lots past the cap keep the basis they were handed when their own transfer
   * was first linked, so a change at the head of the chain never reaches them —
   * and nothing reports that it did not. The number that goes stale is a cost
   * basis, which lands on Form 8949. So the walk now terminates on its visited
   * set alone and the chain length is irrelevant; this test is what holds that
   * open, by using a chain nobody would pick a cap above.
   *
   * The book: 3 shares bought for $1,000.00 plus a $0.01 commission, so
   * $1,000.01 of basis over 3 shares — a figure that does not divide evenly, and
   * whose cumulative apportionment is therefore sensitive to outflow ORDER:
   *
   *     cum(1) = 333.336667   cum(2) = 666.673333   cum(3) = 1,000.01
   *
   * One share then walks CHAIN_LENGTH accounts, hop by hop. Because the whole
   * balance of each intermediate lot moves on, every hop carries the head's
   * slice unchanged, so the far end must read exactly what the head apportioned.
   *
   * Then the staleness is provoked exactly as ordinary bookkeeping would: a
   * BACKDATED transfer of another share out of the head lot is entered, and only
   * the HEAD account is re-scrubbed. That demotes the chain's outflow from the
   * lot's first to its second, changing its slice from cum(1) = 333.336667 to
   * cum(2) - cum(1) = 333.336666. The reconcile pass has to carry that one
   * millionth all the way down. Under the old cap, hops 1-25 moved and hops
   * 26-40 kept 333.336667 — a chain reporting two different bases for the same
   * share.
   */
  const CHAIN_LENGTH = 40;

  /** guid of the Nth chain account. 0 is the head the shares were bought in. */
  const chainAcct = (i: number) => `chain-${String(i).padStart(2, '0')}-acct-guid-000000`;
  /** Where the backdated transfer's share goes; not part of the chain. */
  const SINK = 'chain-sink-acct-guid-0000000000';

  /**
   * Hop N's post date: one day per hop from 2024-06-01, computed rather than
   * string-formatted because a 40-hop chain runs off the end of the month.
   * Every hop still lands after the buy and after the backdated transfer.
   */
  function chainDate(hop: number): string {
    const d = new Date(Date.UTC(2024, 5, 1));
    d.setUTCDate(d.getUTCDate() + hop);
    return d.toISOString().slice(0, 10);
  }

  function seedChain() {
    seedBook();
    for (let i = 0; i <= CHAIN_LENGTH; i++) {
      db.t.accounts.push(acct(chainAcct(i), 'AAPL', 'STOCK', ASSETS, AAPL));
    }
    db.t.accounts.push(acct(SINK, 'AAPL', 'STOCK', ASSETS, AAPL));

    addTx('tx-chain-buy', '2022-01-10', [
      ['chain-buy', chainAcct(0), 3, 1000],
      ['chain-buy-comm', COMMISSIONS, 0.01, 0.01],
      ['chain-buy-cash', CASH, -1000.01, -1000.01],
    ]);
    // One share, hop by hop, each transfer a day later than the last so the
    // chain's own ordering is never in question.
    for (let hop = 1; hop <= CHAIN_LENGTH; hop++) {
      addTx(`tx-hop-${hop}`, chainDate(hop), [
        [`out-${hop}`, chainAcct(hop - 1), -1, 0],
        [`in-${hop}`, chainAcct(hop), 1, 0],
      ]);
    }
  }

  /** Scrubs head first, then each hop, so every link is made in order. */
  async function scrubWholeChain() {
    for (let i = 0; i <= CHAIN_LENGTH; i++) {
      await autoAssignLots(chainAcct(i), 'fifo');
    }
  }

  /** The carried basis, in millionths, of the lot holding hop N's share. */
  function hopBasisUnits(hop: number): number {
    const lotGuid = split(`in-${hop}`).lot_guid as string;
    return carriedBasisUnits(lotGuid);
  }

  /** Every hop's carried basis, so a divergence names the hop it starts at. */
  function chainBasisUnits(): number[] {
    return Array.from({ length: CHAIN_LENGTH }, (_, i) => hopBasisUnits(i + 1));
  }

  it('carries the head lot\'s slice to hop 40, not just to the old 25-hop cap', async () => {
    seedChain();
    await scrubWholeChain();

    // Every hop, including the ones past 25, reads the head's first-outflow
    // slice. Asserted as the whole array so a failure names the hop.
    expect(chainBasisUnits()).toEqual(Array(CHAIN_LENGTH).fill(333_336_667));
  });

  it('re-apportions all 40 hops when a backdated outflow demotes the chain', async () => {
    seedChain();
    await scrubWholeChain();
    expect(hopBasisUnits(CHAIN_LENGTH)).toBe(333_336_667);

    // The missed earlier transfer, entered afterwards. Only the HEAD account is
    // re-scrubbed: propagating from there is the reconcile pass's whole job.
    addTx('tx-backdated', '2024-05-20', [
      ['back-out', chainAcct(0), -1, 0],
      ['back-in', SINK, 1, 0],
    ]);
    await autoAssignLots(chainAcct(0), 'fifo');
    await autoAssignLots(SINK, 'fifo');

    // The chain's outflow is now the head lot's SECOND, so its slice drops by
    // the residual millionth — and that has to reach hop 40, not hop 25.
    expect(chainBasisUnits()).toEqual(Array(CHAIN_LENGTH).fill(333_336_666));
    // Named explicitly: this exact hop is the one the old cap left stale.
    expect(hopBasisUnits(26)).toBe(333_336_666);
    expect(hopBasisUnits(CHAIN_LENGTH)).toBe(333_336_666);

    // And the head lot's basis is still conserved across all three outflows:
    // the backdated share, the chain's share, and the share left in the lot.
    expect(carriedBasisUnits(split('back-in').lot_guid as string)).toBe(333_336_667);
  });

  it('reports the far end\'s gain on the conserved basis, not the stale one', async () => {
    seedChain();
    await scrubWholeChain();
    addTx('tx-backdated', '2024-05-20', [
      ['back-out', chainAcct(0), -1, 0],
      ['back-in', SINK, 1, 0],
    ]);
    await autoAssignLots(chainAcct(0), 'fifo');
    await autoAssignLots(SINK, 'fifo');

    // Sell at the far end. $1,000 proceeds against $333.336666 of basis.
    addTx('tx-chain-sell', '2025-03-03', [
      ['chain-sell', chainAcct(CHAIN_LENGTH), -1, -1000],
      ['chain-sell-cash', CASH, 1000, 1000],
    ]);
    const res = await autoAssignLots(chainAcct(CHAIN_LENGTH), 'fifo');

    // A stale far end would report 666.663333 here — one millionth adrift, on
    // the number that reaches Form 8949.
    expect(Math.round(res.totalRealizedGain * 1e6)).toBe(666_663_334);
    expect(Math.round(await lotsReportRealizedGain(chainAcct(CHAIN_LENGTH)) * 1e6))
      .toBe(666_663_334);
    expect(Math.round(await form8949Gain(chainAcct(CHAIN_LENGTH)) * 1e6))
      .toBe(666_663_334);
  });
});

describe('apportionCarriedBasis', () => {
  const units = (amount: number) => Math.round(amount * 1e6);
  const slice = (totalBasis: number, boughtShares: number, sharesOutBefore: number, shares: number) =>
    apportionCarriedBasis({ totalBasis, boughtShares, sharesOutBefore, shares });

  it('conserves a $0.03 commission across 50,000 one-share transfers', () => {
    // The reviewer's shape: $50,000.00 + $0.03 over 50,000 shares is
    // $1.0000006 each, which six-decimal rounding turns into $1.000001 —
    // $50,000.05 of stored basis, $0.02 of the commission counted twice.
    const SOURCE_BASIS = 50_000.03;
    const SHARES = 50_000;

    let carriedOut = 0;
    for (let share = 0; share < SHARES; share++) {
      carriedOut += units(slice(SOURCE_BASIS, SHARES, share, 1));
    }

    expect(carriedOut).toBe(units(SOURCE_BASIS));
    expect(carriedOut / 1e6).toBe(SOURCE_BASIS);
    // Selling all 50,000 at $2.00: the stored basis yielded $49,999.95.
    expect(100_000 - carriedOut / 1e6).toBeCloseTo(49_999.97, 6);
  });

  it('holds back the residual while the lot still has shares in it', () => {
    const first = units(slice(1000.01, 3, 0, 1));
    const second = units(slice(1000.01, 3, 1, 1));
    // Two of three shares gone: strictly less than the whole basis is out.
    expect(first + second).toBeLessThan(units(1000.01));
    expect(first + second + units(slice(1000.01, 3, 2, 1))).toBe(units(1000.01));
  });

  it('starts a transfer where an earlier sale out of the same lot left off', () => {
    // A 1-share sale takes the first slice; the 2 shares transferred out after
    // it carry the REST, not two more first slices.
    expect(units(slice(1000.01, 3, 1, 2))).toBe(units(1000.01) - units(slice(1000.01, 3, 0, 1)));
  });

  it('carries the whole basis when the whole lot leaves at once', () => {
    expect(units(slice(1010, 100, 0, 100))).toBe(units(1010));
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
