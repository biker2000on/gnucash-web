/**
 * TRUE AVERAGE COST BASIS (ASI-1-004).
 *
 * `autoAssignLots(acct, 'average')` used to call assignFIFO and label the
 * result "fifo (average cost not implemented)": a user who elected average
 * cost silently received FIFO realized gains, and FIFO gains are a different
 * number on a filed return. These tests drive the real thing end to end —
 * autoAssignLots against an in-memory Prisma fake, then the SAME book read
 * back through the two reporting paths that produce user-facing tax figures
 * (`getAccountLots` and `lotToRealizedSales` / Form 8949) — and pin every
 * expected figure to a hand computation written out in the test.
 *
 * Where average and FIFO disagree, BOTH numbers are computed by hand and both
 * are asserted, so the difference is the assertion rather than an artifact.
 *
 * Method assumptions under test (see the JURISDICTIONAL SCOPE note in
 * lot-assignment.ts): the pool is one account's holding of one commodity;
 * basis is fee-inclusive; and shares are deemed disposed oldest-first so the
 * short/long-term split follows Treas. Reg. §1.1012-1(e)(7)(ii) even though
 * basis is pooled.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';


// The fake Prisma lives in ./helpers/avg-cost-book so the depth/repair proof
// file can drive the same book. The factory is async because vi.mock is
// hoisted above the imports below - it cannot close over an imported binding.
vi.mock('../prisma', async () => ({
  default: (await import('./helpers/avg-cost-book')).fakePrisma,
}));
vi.mock('../db', () => ({ tryWithDatabaseAdvisoryLock: vi.fn() }));
vi.mock('../book-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../book-lock')>()),
  bookLockKey: vi.fn(() => 'lock'),
  tryAcquireBookLock: vi.fn(async () => true),
  // findOrCreateAccount (reached when generateCapitalGains has to create the
  // Income:Capital Gains hierarchy) guards its check-then-create with this.
  accountNameLockKey: vi.fn((parent: string, name: string) => `${parent}:${name}`),
  acquireNamedXactLock: vi.fn(async () => false),
}));
vi.mock('../commodities', () => ({ getLatestPrice: vi.fn(async () => null) }));

import { autoAssignLots, revertScrubRun } from '../lot-assignment';
import {
  AvgBasisHistoryRepairRequiredError,
  writeAvgBasisWrites,
  writeAvgBasisRemaining,
  readAvgBasisWrites,
  readLiveAvgBasisRemaining,
  type PrismaTx,
} from '../lot-scrub';
import { getAccountLots, computeRealizedGain, remainingCostBasis } from '../lots';
import { loadTradeFees } from '../trade-fees';
import { lotToRealizedSales } from '../reports/capital-gains';
import {
  AVG_SLOT_NAMES,
  STOCK_ACCT,
  STOCK_ACCT_2,
  addOwnAccountTransfer,
  addTrade,
  allLotGuids,
  avgBasisHistory,
  avgBasisOf,
  avgRunOf,
  db,
  fakePrisma,
  gainsPostings,
  generatedFor,
  lotOfSplit,
  nextGuid,
  qtyFrac,
  resetGuidSeq,
  USD,
  rawSlotOf,
  remainingOf,
  remainingRunOf,
  resetDb,
  seedBaseAccounts,
  slotOf,
  slotsNamed,
  stashHistory,
  stashOf,
  stashRunOf,
  writeHistory,
} from './helpers/avg-cost-book';


beforeEach(() => {
  resetDb();
  resetGuidSeq();
  seedBaseAccounts();
});

describe('average cost vs FIFO on identical input', () => {
  /**
   * Buy  2024-01-01: 10 sh for $100  ($10.00/sh)
   * Buy  2024-06-01: 10 sh for $300  ($30.00/sh)
   * Sell 2024-07-01: 10 sh for $400  ($40.00/sh)
   *
   * FIFO    — the sale consumes the January lot outright:
   *           basis $100, gain 400 − 100 = $300.
   * AVERAGE — pool at the sale date is 20 sh / $400 → $20.00 per share;
   *           10 sh sold ⇒ basis $200, gain 400 − 200 = $200.
   *
   * $100 of taxable gain hangs on which method the engine actually ran.
   */
  const seedBook = () => {
    addTrade('2024-01-01', 10, 100);
    addTrade('2024-06-01', 10, 300);
    return addTrade('2024-07-01', -10, 400);
  };

  it('FIFO realizes the hand-computed $300', async () => {
    seedBook();
    const result = await autoAssignLots(STOCK_ACCT, 'fifo');

    expect(result.method).toBe('fifo');
    expect(result.totalRealizedGain).toBeCloseTo(300, 6);
  });

  it('average realizes the hand-computed $200 — a different number, not FIFO', async () => {
    const sellGuid = seedBook();
    const result = await autoAssignLots(STOCK_ACCT, 'average');

    expect(result.method).toBe('average');
    expect(result.totalRealizedGain).toBeCloseTo(200, 6);
    expect(result.totalRealizedGain).not.toBeCloseTo(300, 2);

    // The pooled basis of exactly the shares sold: 10 × $20.00.
    expect(avgBasisOf(sellGuid)).toBeCloseTo(200, 6);
    // ...and the untouched June lot keeps the SAME per-share basis, because
    // pooling re-prices every open share, not just the ones that were sold.
    const openLot = db.lots.find(l => l.guid !== lotOfSplit(sellGuid))!.guid as string;
    expect(slotOf(openLot, 'avg_cost_basis_remaining')).toBeCloseTo(200, 6);
  });

  it('reports the average basis through the lots report and Form 8949', async () => {
    seedBook();
    await autoAssignLots(STOCK_ACCT, 'average');

    const lots = await getAccountLots(STOCK_ACCT);
    const closed = lots.find(l => l.isClosed)!;
    expect(closed.realizedGain).toBeCloseTo(200, 6);
    expect(closed.totalCost).toBeCloseTo(200, 6);

    const sales = lotToRealizedSales(closed, 'AAPL');
    expect(sales).toHaveLength(1);
    expect(sales[0].proceeds).toBeCloseTo(400, 6);
    expect(sales[0].costBasis).toBeCloseTo(200, 6);

    // The still-open lot is marked to the pool average too, so unrealized
    // gain is not measured against a per-lot cost the election discarded.
    const open = lots.find(l => !l.isClosed)!;
    expect(open.averageBasisRemaining).toBeCloseTo(200, 6);
    expect(open.totalCost).toBeCloseTo(200, 6);
  });
});

describe('average cost — partial sale re-averages the pool', () => {
  /**
   * Buy  2024-01-01: 10 sh for $100                  pool 10 sh / $100
   * Sell 2024-02-01:  4 sh for  $80  @ $10.00 basis  ⇒ basis $40, gain $40
   *                                                  pool  6 sh /  $60
   * Buy  2024-03-01: 10 sh for $200                  pool 16 sh / $260
   * Sell 2024-04-01:  8 sh for $200  @ $16.25 basis  ⇒ basis $130, gain $70
   *
   * The second sale MUST be priced at $16.25 — the average as of ITS date.
   * Pricing it from the final pool, or from the first sale's $10.00, is wrong
   * in opposite directions.
   *
   * Lot consumption is oldest-first, so the April sale takes the January lot's
   * last 6 shares (closing it) and 2 shares from the March lot.
   *   January lot: proceeds $80 + $150 = $230, basis $40 + (6 × $16.25) = $137.50
   *                ⇒ realized $92.50, which is the only gain BOOKED (the March
   *                  lot is still open and holds the other $17.50).
   */
  const seedBook = () => {
    addTrade('2024-01-01', 10, 100);
    const firstSell = addTrade('2024-02-01', -4, 80);
    addTrade('2024-03-01', 10, 200);
    const secondSell = addTrade('2024-04-01', -8, 200);
    return { firstSell, secondSell };
  };

  it('prices each sale at the average as of its own date', async () => {
    const { firstSell, secondSell } = seedBook();
    await autoAssignLots(STOCK_ACCT, 'average');

    // First sale: 4 × $10.00
    expect(avgBasisOf(firstSell)).toBeCloseTo(40, 6);
    // Second sale, first allocation (6 sh from the January lot): 6 × $16.25
    expect(avgBasisOf(secondSell)).toBeCloseTo(97.5, 6);
    // ...and its sub-split for the 2 shares taken from the March lot.
    const subSplit = db.splits.find(
      s => s.tx_guid === db.splits.find(x => x.guid === secondSell)!.tx_guid
        && s.guid !== secondSell
        && s.account_guid === STOCK_ACCT,
    )!.guid as string;
    expect(avgBasisOf(subSplit)).toBeCloseTo(32.5, 6);
  });

  it('books $92.50 on the closed lot and leaves the rest with the open one', async () => {
    seedBook();
    const result = await autoAssignLots(STOCK_ACCT, 'average');

    expect(result.totalRealizedGain).toBeCloseTo(92.5, 6);

    const lots = await getAccountLots(STOCK_ACCT);
    const closed = lots.find(l => l.isClosed)!;
    const open = lots.find(l => !l.isClosed)!;
    expect(closed.realizedGain).toBeCloseTo(92.5, 6);
    // Open lot: 8 shares left in a pool of 8 sh / $130 ⇒ $16.25 per share.
    expect(open.totalShares).toBeCloseTo(8, 6);
    expect(open.averageBasisRemaining).toBeCloseTo(130, 6);
    expect(open.realizedGain).toBeCloseTo(50 - 32.5, 6);
  });

  it('FIFO books a different number on the same book', async () => {
    seedBook();
    const result = await autoAssignLots(STOCK_ACCT, 'fifo');

    // FIFO: the January lot's 10 shares cost $100 ⇒ $10.00/sh. It sells 4 for
    // $80 and 6 for $150, so its realized gain is 230 − 100 = $130.
    expect(result.totalRealizedGain).toBeCloseTo(130, 6);
  });
});

describe('average cost — full liquidation', () => {
  /**
   * Buy  2024-01-01: 10 sh for $100
   * Buy  2024-06-01: 10 sh for $300
   * Sell 2024-07-01: 20 sh for $500   ⇒ $25.00 per share proceeds
   *
   * Pool 20 sh / $400 ⇒ $20.00 per share. Each lot: proceeds $250, basis $200,
   * gain $50. FIFO would instead book +$150 and −$50 for the same $100 total —
   * the same aggregate, split differently across lots and (below) across
   * holding periods.
   */
  it('splits the gain evenly across both lots at the pooled basis', async () => {
    addTrade('2024-01-01', 10, 100);
    addTrade('2024-06-01', 10, 300);
    addTrade('2024-07-01', -20, 500);

    const result = await autoAssignLots(STOCK_ACCT, 'average');

    expect(result.totalRealizedGain).toBeCloseTo(100, 6);
    const amounts = gainsPostings().map(p => p.amount).sort((a, b) => a - b);
    expect(amounts).toHaveLength(2);
    expect(amounts[0]).toBeCloseTo(50, 6);
    expect(amounts[1]).toBeCloseTo(50, 6);

    const lots = await getAccountLots(STOCK_ACCT);
    expect(lots.every(l => l.isClosed)).toBe(true);
    for (const lot of lots) expect(lot.realizedGain).toBeCloseTo(50, 6);
  });
});

describe('average cost — short vs long term', () => {
  /**
   * Buy  2023-01-01: 10 sh for $100   (held > 1 year at the sale → LONG)
   * Buy  2024-06-01: 10 sh for $300   (held < 1 year at the sale → SHORT)
   * Sell 2024-08-01: 20 sh for $600   ⇒ $30.00 per share proceeds
   *
   * Basis is POOLED ($20.00/sh) but the shares are still deemed disposed
   * oldest-first (Treas. Reg. §1.1012-1(e)(7)(ii)), so:
   *   long-term  lot: proceeds $300 − basis $200 = +$100
   *   short-term lot: proceeds $300 − basis $200 = +$100
   * FIFO on the same book books +$200 long-term and $0 short-term, so the
   * term split — not just the total — depends on the method.
   */
  it('books equal long- and short-term gains at the pooled basis', async () => {
    addTrade('2023-01-01', 10, 100);
    addTrade('2024-06-01', 10, 300);
    addTrade('2024-08-01', -20, 600);

    const result = await autoAssignLots(STOCK_ACCT, 'average');

    expect(result.totalRealizedGain).toBeCloseTo(200, 6);
    const postings = gainsPostings();
    expect(postings).toHaveLength(2);
    const byTerm = Object.fromEntries(postings.map(p => [p.incomeAccount, p.amount]));
    expect(byTerm['Long Term']).toBeCloseTo(100, 6);
    expect(byTerm['Short Term']).toBeCloseTo(100, 6);
  });

  it('FIFO books the whole gain long-term on the same book', async () => {
    addTrade('2023-01-01', 10, 100);
    addTrade('2024-06-01', 10, 300);
    addTrade('2024-08-01', -20, 600);

    await autoAssignLots(STOCK_ACCT, 'fifo');

    const postings = gainsPostings();
    // Long-term lot: 300 − 100 = +$200. The short-term lot breaks even
    // (300 − 300) and books no entry at all.
    expect(postings).toHaveLength(1);
    expect(postings[0].incomeAccount).toBe('Long Term');
    expect(postings[0].amount).toBeCloseTo(200, 6);
  });
});

describe('average cost — a transferred lot enters the pool at its carried basis', () => {
  /**
   * Pre-existing transfer-destination lot (ASI-1-002 / ADV-H4): 10 shares that
   * arrived on 2024-05-01 at $0 recorded value, carrying $150 of original
   * basis and a 2023-01-01 acquisition date.
   *
   * Buy  2024-02-01: 10 sh for $250
   * Sell 2024-06-01: 10 sh for $400
   *
   * Pool at the sale: 20 sh / ($150 + $250) = $400 ⇒ $20.00 per share, so the
   * 10 shares sold carry $200 of basis and realize $200.
   *
   * The two ways to get this wrong are both excluded by the numbers:
   *   transferred shares entering at $0   ⇒ pool $250/20 = $12.50 ⇒ gain $275
   *   FIFO against the transferred lot    ⇒ basis $150          ⇒ gain $250
   * The carried ACQUISITION DATE also has to survive: it is what makes the
   * transferred (older) shares the ones deemed sold.
   */
  const seedTransferLot = () => {
    const xferLot = 'xfer-lot';
    db.lots.push({ guid: xferLot, account_guid: STOCK_ACCT, is_closed: 0 });
    db.slots.push(
      { obj_guid: xferLot, name: 'title', slot_type: 4, string_val: 'Transfer 2024-05-01' },
      { obj_guid: xferLot, name: 'acquisition_date', slot_type: 4, string_val: '2023-01-01T00:00:00.000Z' },
      { obj_guid: xferLot, name: 'carried_basis', slot_type: 4, string_val: '150' },
      { obj_guid: xferLot, name: 'source_lot_guid', slot_type: 4, string_val: 'source-lot-elsewhere' },
    );
    const xferTx = nextGuid('tx');
    db.transactions.push({ guid: xferTx, post_date: new Date('2024-05-01'), currency_guid: USD, description: 'transfer in' });
    db.splits.push({
      guid: nextGuid('xferin-split'),
      tx_guid: xferTx,
      account_guid: STOCK_ACCT,
      memo: '', action: '', reconcile_state: 'n', reconcile_date: null,
      quantity_num: qtyFrac(10), quantity_denom: 100n,
      value_num: 0n, value_denom: 100n,
      lot_guid: xferLot,
    });
    return xferLot;
  };

  it('pools the carried basis, not $0 and not the lot\'s own cost', async () => {
    const xferLot = seedTransferLot();
    addTrade('2024-02-01', 10, 250);
    const sellGuid = addTrade('2024-06-01', -10, 400);

    const result = await autoAssignLots(STOCK_ACCT, 'average');

    // Carried acquisition date wins the FIFO ordering: the transferred lot is
    // the one deemed sold, and it closes.
    expect(lotOfSplit(sellGuid)).toBe(xferLot);
    expect(avgBasisOf(sellGuid)).toBeCloseTo(200, 6);
    expect(result.totalRealizedGain).toBeCloseTo(200, 6);
    expect(result.totalRealizedGain).not.toBeCloseTo(275, 2); // $0-basis transfer
    expect(result.totalRealizedGain).not.toBeCloseTo(250, 2); // FIFO

    // Long-term: the CARRIED 2023-01-01 acquisition date, not the 2024-05-01
    // transfer date, decides the holding period.
    expect(gainsPostings()).toEqual([{ amount: 200, incomeAccount: 'Long Term' }]);
  });
});

describe('average cost — commissions', () => {
  /**
   * Buy  2024-01-01: 10 sh for $100 + $10 commission ⇒ $110 into the pool
   * Buy  2024-02-01: 10 sh for $200 + $10 commission ⇒ $210 into the pool
   * Sell 2024-06-01: 10 sh for $400 +  $5 commission
   *
   * Pool 20 sh / $320 ⇒ $16.00 per share, so 10 shares sold carry $160 of
   * basis. Per IRS Pub. 550 a buy-side commission is capitalized into basis
   * (never deducted) and a sell-side commission reduces the amount realized:
   *   ledger entry (gross proceeds, as for FIFO): 400 − 160 = $240
   *   reported gain (net of the sell fee):        395 − 160 = $235
   * Ignoring commissions entirely would give 400 − 150 = $250, and FIFO with
   * commissions 400 − 110 = $290.
   */
  const seedBook = () => {
    addTrade('2024-01-01', 10, 100, 10);
    addTrade('2024-02-01', 10, 200, 10);
    return addTrade('2024-06-01', -10, 400, 5);
  };

  it('capitalizes buy-side commissions into the pooled basis', async () => {
    const sellGuid = seedBook();
    const result = await autoAssignLots(STOCK_ACCT, 'average');

    expect(avgBasisOf(sellGuid)).toBeCloseTo(160, 6);
    expect(result.totalRealizedGain).toBeCloseTo(240, 6);
    expect(result.totalRealizedGain).not.toBeCloseTo(250, 2); // fees ignored
    expect(result.totalRealizedGain).not.toBeCloseTo(290, 2); // FIFO with fees
  });

  it('nets the sell-side commission off proceeds in the lots report and Form 8949', async () => {
    seedBook();
    await autoAssignLots(STOCK_ACCT, 'average');

    const lots = await getAccountLots(STOCK_ACCT, { includeTradeFees: true });
    const closed = lots.find(l => l.isClosed)!;
    expect(closed.realizedGain).toBeCloseTo(235, 6);

    const fees = await loadTradeFees(closed.splits.map(s => s.txGuid));
    const sales = lotToRealizedSales(closed, 'AAPL', fees.fees);
    expect(sales).toHaveLength(1);
    expect(sales[0].proceeds).toBeCloseTo(395, 6);
    // Buy-side commissions are already inside the pooled basis and must not
    // be added a second time here.
    expect(sales[0].costBasis).toBeCloseTo(160, 6);
  });
});

describe('average cost — chronological replay', () => {
  /**
   * A sale between two buys must be priced from the pool AS OF THE SALE, never
   * from the final pool — the same requirement that makes LIFO consume only
   * lots existing at the sell date.
   *
   * Buy  2024-01-01: 10 sh for $100        pool 10 sh / $100 ⇒ $10.00/sh
   * Sell 2024-03-01:  5 sh for $150        basis 5 × $10.00 = $50
   * Buy  2024-06-01: 10 sh for $900        (irrelevant to the March sale)
   *
   * Averaging the whole book instead would give (100 + 900)/20 = $50.00/sh and
   * a $250 basis — a fabricated $200 loss on a genuinely profitable sale.
   */
  it('prices a sale from the pool at its own date, not the final pool', async () => {
    addTrade('2024-01-01', 10, 100);
    const sellGuid = addTrade('2024-03-01', -5, 150);
    addTrade('2024-06-01', 10, 900);

    await autoAssignLots(STOCK_ACCT, 'average');

    expect(avgBasisOf(sellGuid)).toBeCloseTo(50, 6);
    expect(avgBasisOf(sellGuid)).not.toBeCloseTo(250, 2);
  });
});

describe('average cost — basis travels across an own-account transfer', () => {
  /**
   * Source account:
   *   Buy 2024-01-01: 10 sh for $100
   *   Buy 2024-02-01: 10 sh for $300     pool 20 sh / $400 ⇒ $20.00/sh
   *   Transfer out 2024-03-01: 10 sh at $0 recorded value
   *     ⇒ $200 of POOLED basis leaves, and the January lot closes with NO gain
   *       booked (a transfer is not a taxable event).
   * Destination account:
   *   Sell 2024-06-01: 10 sh for $500     basis $200 ⇒ gain $300
   *
   * The destination must receive $200, not the January lot's own $100 cost
   * (which would make the sale look like a $400 gain) and not $0.
   */
  const seedBook = () => {
    addTrade('2024-01-01', 10, 100);
    addTrade('2024-02-01', 10, 300);
    const transfer = addOwnAccountTransfer('2024-03-01', 10, STOCK_ACCT, STOCK_ACCT_2);
    const destSell = addTrade('2024-06-01', -10, 500, 0, STOCK_ACCT_2);
    return { transfer, destSell };
  };

  it('carries the POOLED basis to the destination lot, not the source lot\'s cost', async () => {
    const { transfer, destSell } = seedBook();

    // Source first — scrubAllAccounts orders accounts topologically for
    // exactly this reason: the destination reads what the source recorded.
    const source = await autoAssignLots(STOCK_ACCT, 'average');
    expect(avgBasisOf(transfer.out)).toBeCloseTo(200, 6);
    // A transfer-out books nothing, even though it closed the January lot.
    expect(source.totalRealizedGain).toBeCloseTo(0, 6);
    expect(gainsPostings()).toHaveLength(0);

    const dest = await autoAssignLots(STOCK_ACCT_2, 'average');
    const destLot = lotOfSplit(transfer.in);
    expect(slotOf(destLot, 'carried_basis')).toBeCloseTo(200, 6);

    expect(avgBasisOf(destSell)).toBeCloseTo(200, 6);
    expect(dest.totalRealizedGain).toBeCloseTo(300, 6);
    expect(dest.totalRealizedGain).not.toBeCloseTo(400, 2); // source lot's own $100
    expect(dest.totalRealizedGain).not.toBeCloseTo(500, 2); // transferred in at $0
  });
});

describe('shared basis helpers (pure)', () => {
  it('computeRealizedGain nets only SELL-side fees off a pooled basis', () => {
    // 10 shares disposed for $400 gross with a $5 sell commission, pooled
    // basis $160 (which already contains the buy-side commissions).
    // Gain = (400 − 5) − 160 = $235. Re-adding a buy fee would give $225.
    const gain = computeRealizedGain(
      [
        { guid: 'buy', shares: 10, value: 100 },
        { guid: 'sell', shares: -10, value: -400, avgCostBasis: 160 },
      ],
      true,
      0,
      new Set(),
      new Map([['buy', 10], ['sell', 5]]),
    );
    expect(gain).toBeCloseTo(235, 6);
  });

  it('computeRealizedGain ignores carriedBasis once a disposal is pooled', () => {
    // carried_basis is already inside the pooled figure; adding it here would
    // subtract the transferred shares' basis twice.
    const gain = computeRealizedGain(
      [
        { guid: 'in', shares: 10, value: 0 },
        { guid: 'sell', shares: -10, value: -400, avgCostBasis: 200 },
      ],
      true,
      150,
    );
    expect(gain).toBeCloseTo(200, 6);
  });

  it('remainingCostBasis uses the recorded pool basis, not a pro-rata of totalCost', () => {
    // A lot bought 10 shares and disposed of 5 across two sales priced at
    // different pool averages ($10 then $30), leaving 5 shares worth $150 at
    // the final average. totalCost = 150 + 20 + 90 = $260, so pro-rating
    // would say 260 × 5/10 = $130 — $20 short.
    const lot = {
      averageBasisRemaining: 150,
      totalShares: 5,
      totalCost: 260,
      splits: [
        { shares: 10, value: 100 },
        { shares: -2, value: -60 },
        { shares: -3, value: -120 },
      ],
    } as unknown as Parameters<typeof remainingCostBasis>[0];
    expect(remainingCostBasis(lot)).toBeCloseTo(150, 6);

    const withoutPool = { ...lot, averageBasisRemaining: null };
    expect(remainingCostBasis(withoutPool)).toBeCloseTo(130, 6);
  });
});

describe('average-cost artifacts are removed when the election changes', () => {
  it('a FIFO re-scrub drops the average basis so nothing reports a stale pool', async () => {
    addTrade('2024-01-01', 10, 100);
    addTrade('2024-06-01', 10, 300);
    const sellGuid = addTrade('2024-07-01', -10, 400);

    const runA = await autoAssignLots(STOCK_ACCT, 'average');
    expect(avgBasisOf(sellGuid)).toBeCloseTo(200, 6);
    expect(avgRunOf(sellGuid)).toBe(runA.runId);

    // Re-scrub the same account under FIFO without clearing first.
    await autoAssignLots(STOCK_ACCT, 'fifo');

    expect(avgBasisOf(sellGuid)).toBeUndefined();
    // EVERY average-cost slot name, provenance companions included. A run
    // stamp left behind on a FIFO book is not itself a wrong number, but it
    // would let a later run-scoped revert believe it still owns a value here.
    for (const name of AVG_SLOT_NAMES) {
      expect(slotsNamed(name)).toHaveLength(0);
    }

    // ...and the lots report falls straight back to per-lot FIFO basis.
    const lots = await getAccountLots(STOCK_ACCT);
    const closed = lots.find(l => l.isClosed)!;
    expect(closed.averageBasisRemaining ?? null).toBeNull();
    expect(closed.splits.every(s => s.avgCostBasis === undefined)).toBe(true);
  });

  it('average → FIFO → average leaves nothing owned by the ABANDONED run', async () => {
    addTrade('2024-01-01', 10, 100);
    addTrade('2024-06-01', 10, 300);
    const sellGuid = addTrade('2024-07-01', -10, 400);

    const runA = await autoAssignLots(STOCK_ACCT, 'average');
    await autoAssignLots(STOCK_ACCT, 'fifo');

    // Elect average again, with a new purchase for the run to process.
    addTrade('2025-01-05', 10, 500);
    const runC = await autoAssignLots(STOCK_ACCT, 'average');

    // Every surviving average-cost slot belongs to run C. A row still stamped
    // runA would be a value computed under a pool that FIFO already dissolved.
    const ownerSlots = db.slots.filter(
      s => s.name === 'avg_cost_basis_run' || s.name === 'avg_cost_basis_remaining_run',
    );
    expect(ownerSlots.length).toBeGreaterThan(0);
    expect(ownerSlots.every(s => s.string_val === runC.runId)).toBe(true);
    expect(ownerSlots.some(s => s.string_val === runA.runId)).toBe(false);

    // The July sale was priced by FIFO and never re-priced (it is no longer
    // unassigned), so it must still report FIFO's $100 basis / $300 gain —
    // a resurrected pooled basis here is a wrong number on a FIFO Form 8949.
    expect(avgBasisOf(sellGuid)).toBeUndefined();
    const closed = (await getAccountLots(STOCK_ACCT)).find(l => l.isClosed)!;
    const sale = lotToRealizedSales(closed, 'AAPL')[0];
    expect(sale.costBasis).toBeCloseTo(100, 6);
    expect(sale.proceeds - sale.costBasis).toBeCloseTo(300, 6);
  });
});

/**
 * RUN PROVENANCE ON THE AVERAGE-COST SLOTS.
 *
 * `avg_cost_basis` records a filed tax number, and until these tests it
 * carried no record of WHICH scrub run wrote it. Cleanup could therefore only
 * key on the account, and an account accumulates slots from every run that
 * ever scrubbed it — so reverting one run rewrote another run's numbers, and a
 * run that tagged no entity at all could not be reverted from these slots
 * whatsoever. Neither failure raises an error or changes anything visible in
 * the UI; the only symptom is a different number on a return.
 *
 * The design under test: a companion slot (`avg_cost_basis_run` /
 * `avg_cost_basis_remaining_run`) naming the writing run, plus a stash of the
 * value each write displaces (`avg_cost_basis_remaining_prev` and its `_run`).
 * The marker is a distinct slot NAME from `gnucash_web_generated`, so it can
 * sit on the user's own sell split without the revert ever mistaking that
 * split for a generated row to delete.
 */
describe('average-cost run provenance', () => {
  /**
   * DEFECT A — reverting an unrelated later run rewrote a filed sale.
   *
   * Run A  buy 10 @ $10.00, buy 10 @ $30.00, sell 10 @ $40.00
   *        pool 20 sh / $400 ⇒ $20.00/sh ⇒ basis $200, gain $200.
   * Run B  buy 10 for $500 — a later, unrelated purchase.
   * Revert B.
   *
   * Run B's new lot names the ACCOUNT, so the old account-wide sweep deleted
   * run A's $200 slot too. Run A's lots and sale survived, so lots.ts found no
   * average marker and fell back to per-lot basis: that historic Form 8949
   * sale silently became $100 basis / $300 gain.
   */
  it('reverting a later run leaves the earlier run’s sale at $200 basis / $200 gain', async () => {
    addTrade('2024-01-01', 10, 100);
    addTrade('2024-06-01', 10, 300);
    const sellGuid = addTrade('2024-07-01', -10, 400);

    const runA = await autoAssignLots(STOCK_ACCT, 'average');
    expect(avgBasisOf(sellGuid)).toBeCloseTo(200, 6);
    expect(avgRunOf(sellGuid)).toBe(runA.runId);

    const closedLot = lotOfSplit(sellGuid)!;
    const juneLot = allLotGuids().find(g => g !== closedLot)!;
    expect(remainingOf(juneLot)).toBeCloseTo(200, 6);
    expect(remainingRunOf(juneLot)).toBe(runA.runId);

    // ── Run B: an unrelated later purchase ────────────────────────────────
    const lotsBeforeB = new Set(allLotGuids());
    addTrade('2025-02-01', 10, 500);
    const runB = await autoAssignLots(STOCK_ACCT, 'average');
    expect(runB.runId).not.toBe(runA.runId);
    const runBLot = allLotGuids().find(g => !lotsBeforeB.has(g))!;

    // Run B re-averages the pool: 20 sh / $700 ⇒ $35.00/sh, so it OVERWRITES
    // the June lot's open-side number and stashes run A's underneath.
    expect(remainingOf(juneLot)).toBeCloseTo(350, 6);
    expect(remainingRunOf(juneLot)).toBe(runB.runId);
    expect(stashOf(juneLot)).toBeCloseTo(200, 6);
    expect(stashRunOf(juneLot)).toBe(runA.runId);

    // ── Revert run B ──────────────────────────────────────────────────────
    const result = await revertScrubRun(runB.runId);
    expect(result.reverted).toBeGreaterThan(0);

    // THE ASSERTION: run A's already-filed sale is untouched.
    expect(avgBasisOf(sellGuid)).toBeCloseTo(200, 6);
    expect(avgRunOf(sellGuid)).toBe(runA.runId);

    const closed = (await getAccountLots(STOCK_ACCT)).find(l => l.isClosed)!;
    expect(closed.realizedGain).toBeCloseTo(200, 6);
    const sale = lotToRealizedSales(closed, 'AAPL')[0];
    expect(sale.proceeds).toBeCloseTo(400, 6);
    expect(sale.costBasis).toBeCloseTo(200, 6);
    expect(sale.proceeds - sale.costBasis).toBeCloseTo(200, 6);
    // ...and specifically NOT the per-lot fallback the old sweep produced.
    expect(sale.costBasis).not.toBeCloseTo(100, 2);

    // Run B's own artefacts are gone: its lot, and its number on the June lot
    // — which is restored to run A's value, under run A's ownership.
    expect(allLotGuids()).not.toContain(runBLot);
    expect(remainingOf(juneLot)).toBeCloseTo(200, 6);
    expect(remainingRunOf(juneLot)).toBe(runA.runId);
    expect(stashOf(juneLot)).toBeUndefined();
    expect(slotsNamed('avg_cost_basis_remaining').every(
      s => s.string_val !== '350',
    )).toBe(true);
  });

  /**
   * DEFECT B — the mirror: a run that tags NOTHING.
   *
   * A sale that fits inside one lot is assigned straight to the user's own
   * split (splitSellAcrossLots creates no sub-split), and a lot that does not
   * close generates no gains posting. Such a run therefore stamps
   * `gnucash_web_generated` on nothing at all — so revertScrubRun's early
   * return fired, the caller was told `{reverted: 0}`, and the run's pooled
   * basis stayed live for computeCarriedBasis and Form 8949 to read.
   */
  it('reverts a run whose only trace is an average-cost slot', async () => {
    addTrade('2024-01-01', 20, 400);          // 20 sh @ $20.00
    const runA = await autoAssignLots(STOCK_ACCT, 'average');
    const lot = allLotGuids()[0];
    expect(remainingOf(lot)).toBeCloseTo(400, 6);
    expect(remainingRunOf(lot)).toBe(runA.runId);

    const sellGuid = addTrade('2024-09-01', -5, 200);
    const runB = await autoAssignLots(STOCK_ACCT, 'average');

    // The shape that makes this run invisible to the tagged sweep.
    expect(runB.lotsCreated).toBe(0);
    expect(runB.splitsCreated).toBe(0);
    expect(runB.gainsTransactions).toBe(0);
    expect(generatedFor(runB.runId)).toHaveLength(0);
    // It did write a tax number, though: 5 sh × $20.00.
    expect(avgBasisOf(sellGuid)).toBeCloseTo(100, 6);
    expect(avgRunOf(sellGuid)).toBe(runB.runId);

    const result = await revertScrubRun(runB.runId);

    // Previously {reverted: 0} with the slot left standing.
    expect(result.reverted).toBeGreaterThan(0);
    expect(avgBasisOf(sellGuid)).toBeUndefined();
    expect(avgRunOf(sellGuid)).toBeUndefined();
    // Run A's open-side number is back, under run A's ownership.
    expect(remainingOf(lot)).toBeCloseTo(400, 6);
    expect(remainingRunOf(lot)).toBe(runA.runId);
  });

  it('reports {reverted: 0} and touches nothing for a run id that owns nothing', async () => {
    addTrade('2024-01-01', 10, 100);
    const sellGuid = addTrade('2024-07-01', -10, 400);
    const runA = await autoAssignLots(STOCK_ACCT, 'average');
    const before = db.slots.length;

    expect(await revertScrubRun('a-run-that-never-existed')).toEqual({ reverted: 0 });
    expect(db.slots).toHaveLength(before);
    expect(avgBasisOf(sellGuid)).toBeCloseTo(100, 6);
    expect(avgRunOf(sellGuid)).toBe(runA.runId);
  });

  /**
   * PARTIAL SCRUB: two average runs, each pricing its own disposal. Reverting
   * the second must leave the first sale's basis — and the report built from
   * it — exactly as filed.
   */
  it('keeps each disposal priced by the run that priced it', async () => {
    addTrade('2024-01-01', 10, 100);
    addTrade('2024-06-01', 10, 300);
    const firstSell = addTrade('2024-07-01', -10, 400);
    const runA = await autoAssignLots(STOCK_ACCT, 'average');

    // Run B: another buy and another sale. Pool at the 2025 sale is the June
    // lot's carried $200 plus $500 ⇒ 20 sh / $700 ⇒ $35.00/sh ⇒ basis $350.
    addTrade('2025-02-01', 10, 500);
    const secondSell = addTrade('2025-03-01', -10, 600);
    const runB = await autoAssignLots(STOCK_ACCT, 'average');

    expect(avgBasisOf(firstSell)).toBeCloseTo(200, 6);
    expect(avgRunOf(firstSell)).toBe(runA.runId);
    expect(avgBasisOf(secondSell)).toBeCloseTo(350, 6);
    expect(avgRunOf(secondSell)).toBe(runB.runId);

    await revertScrubRun(runB.runId);

    expect(avgBasisOf(secondSell)).toBeUndefined();
    expect(avgRunOf(secondSell)).toBeUndefined();
    expect(avgBasisOf(firstSell)).toBeCloseTo(200, 6);
    expect(avgRunOf(firstSell)).toBe(runA.runId);
    expect(slotsNamed('avg_cost_basis')).toHaveLength(1);
  });

  /**
   * INTERRUPTED RUN: a run that wrote basis slots and got no further (no lot,
   * no gains posting, no tag anywhere). Reverting it must remove exactly its
   * own rows.
   */
  it('cleans up a run that left only average-cost slots behind', async () => {
    addTrade('2024-01-01', 10, 100);
    const sellGuid = addTrade('2024-07-01', -10, 400);
    const runA = await autoAssignLots(STOCK_ACCT, 'average');
    const survivor = avgBasisOf(sellGuid);

    // A second disposal priced by a run that then died.
    const orphanSell = addTrade('2024-08-01', -1, 50);
    db.slots.push(
      { obj_guid: orphanSell, name: 'avg_cost_basis', slot_type: 4, string_val: '12.5' },
      { obj_guid: orphanSell, name: 'avg_cost_basis_run', slot_type: 4, string_val: 'run-interrupted' },
    );

    const result = await revertScrubRun('run-interrupted');

    expect(result.reverted).toBe(1);
    expect(avgBasisOf(orphanSell)).toBeUndefined();
    expect(avgRunOf(orphanSell)).toBeUndefined();
    // The completed run beside it is untouched.
    expect(avgBasisOf(sellGuid)).toBeCloseTo(survivor!, 6);
    expect(avgRunOf(sellGuid)).toBe(runA.runId);
  });

  /**
   * MID-FLIGHT LOT DELETION: the lot a run stamped is gone by the time the
   * revert runs. The restore must not re-attach a value to a dead guid.
   */
  it('does not resurrect a slot on a lot that no longer exists', async () => {
    addTrade('2024-01-01', 10, 100);
    const runA = await autoAssignLots(STOCK_ACCT, 'average');
    const lot = allLotGuids()[0];
    expect(remainingRunOf(lot)).toBe(runA.runId);

    addTrade('2024-06-01', 10, 300);
    const runB = await autoAssignLots(STOCK_ACCT, 'average');
    expect(remainingRunOf(lot)).toBe(runB.runId);
    expect(stashRunOf(lot)).toBe(runA.runId);

    // The lot disappears underneath the run's slots.
    db.lots = db.lots.filter(l => l.guid !== lot);

    await expect(revertScrubRun(runB.runId)).resolves.toMatchObject({
      reverted: expect.any(Number),
    });

    for (const name of AVG_SLOT_NAMES) {
      expect(slotsNamed(name).some(s => s.obj_guid === lot)).toBe(false);
    }
  });

  /**
   * OUT-OF-ORDER REVERT: three runs re-price the same lot, then the MIDDLE one
   * is reverted, then the last. Reverting C must not resurrect B's number —
   * B has already been reverted, and a stash is not a licence to bring a
   * reverted run's figure back.
   */
  it('never restores a value belonging to an already-reverted run', async () => {
    addTrade('2024-01-01', 10, 100);           // pool 10 sh / $100 ⇒ $10.00
    const runA = await autoAssignLots(STOCK_ACCT, 'average');
    const lot1 = allLotGuids()[0];
    expect(remainingOf(lot1)).toBeCloseTo(100, 6);

    addTrade('2024-06-01', 10, 300);           // pool 20 sh / $400 ⇒ $20.00
    const runB = await autoAssignLots(STOCK_ACCT, 'average');
    expect(remainingOf(lot1)).toBeCloseTo(200, 6);
    expect(remainingRunOf(lot1)).toBe(runB.runId);
    expect(stashOf(lot1)).toBeCloseTo(100, 6);
    expect(stashRunOf(lot1)).toBe(runA.runId);

    addTrade('2024-09-01', 20, 800);           // pool 40 sh / $1200 ⇒ $30.00
    const runC = await autoAssignLots(STOCK_ACCT, 'average');
    expect(remainingOf(lot1)).toBeCloseTo(300, 6);
    expect(remainingRunOf(lot1)).toBe(runC.runId);
    expect(stashOf(lot1)).toBeCloseTo(200, 6);
    expect(stashRunOf(lot1)).toBe(runB.runId);

    // Revert the MIDDLE run. It no longer owns lot1's live value (run C does),
    // so lot1's number must not change — and B's entry leaves the stack, while
    // A's, belonging to a run nobody has reverted, stays underneath it.
    await revertScrubRun(runB.runId);
    expect(remainingOf(lot1)).toBeCloseTo(300, 6);
    expect(remainingRunOf(lot1)).toBe(runC.runId);
    expect(stashHistory(lot1).some(e => e.run === runB.runId)).toBe(false);
    expect(stashOf(lot1)).toBeCloseTo(100, 6);
    expect(stashRunOf(lot1)).toBe(runA.runId);

    // Now revert C. THE ASSERTION: the value restored is run A's $100 — the
    // topmost write by a run that still stands — and never run B's $200, which
    // left the stack when B was reverted.
    await revertScrubRun(runC.runId);
    expect(remainingOf(lot1)).toBeCloseTo(100, 6);
    expect(remainingRunOf(lot1)).toBe(runA.runId);
    expect(remainingOf(lot1)).not.toBeCloseTo(200, 2);

    // And with A reverted too the lot keeps no pooled number at all.
    await revertScrubRun(runA.runId);
    expect(remainingOf(lot1)).toBeUndefined();
    expect(remainingRunOf(lot1)).toBeUndefined();
    expect(stashHistory(lot1)).toHaveLength(0);
  });

  /**
   * REVERSE-ORDER UNWIND AT DEPTH THREE — the case a one-level stash cannot
   * represent.
   *
   * Three runs re-price the same lot: A $100, B $200, C $300. Undoing them
   * newest-first must walk back down the same staircase — revert C ⇒ B's $200,
   * revert B ⇒ A's $100 — because neither B nor A has been undone at the point
   * their number is restored.
   *
   * A single `_prev` pair holds ONE displaced value, so C's write erased B's
   * record of A. Reverting C put B's $200 back and reverting B then found
   * nothing to restore: the lot fell through to per-lot basis while run A's
   * disposal slots still said part of that basis was spent — double-counted
   * basis, understating every later gain, with nothing visible in the UI.
   */
  it('restores each displaced value in turn when three runs are unwound newest-first', async () => {
    addTrade('2024-01-01', 10, 100);           // pool 10 sh / $100 ⇒ $10.00
    const runA = await autoAssignLots(STOCK_ACCT, 'average');
    const lot1 = allLotGuids()[0];
    expect(remainingOf(lot1)).toBeCloseTo(100, 6);
    expect(remainingRunOf(lot1)).toBe(runA.runId);

    addTrade('2024-06-01', 10, 300);           // pool 20 sh / $400 ⇒ $20.00
    const runB = await autoAssignLots(STOCK_ACCT, 'average');
    expect(remainingOf(lot1)).toBeCloseTo(200, 6);
    expect(remainingRunOf(lot1)).toBe(runB.runId);

    addTrade('2024-09-01', 20, 800);           // pool 40 sh / $1200 ⇒ $30.00
    const runC = await autoAssignLots(STOCK_ACCT, 'average');
    expect(remainingOf(lot1)).toBeCloseTo(300, 6);
    expect(remainingRunOf(lot1)).toBe(runC.runId);

    // Revert C: B owned the value C displaced, and B still stands.
    await revertScrubRun(runC.runId);
    expect(remainingOf(lot1)).toBeCloseTo(200, 6);
    expect(remainingRunOf(lot1)).toBe(runB.runId);

    // Revert B: A owned the value B displaced, and A still stands. THE
    // ASSERTION — a one-level stash arrives here with nothing left to restore.
    await revertScrubRun(runB.runId);
    expect(remainingOf(lot1)).toBeCloseTo(100, 6);
    expect(remainingRunOf(lot1)).toBe(runA.runId);

    // And unwinding the last one empties the lot rather than resurrecting a
    // number from a run that has already been undone.
    await revertScrubRun(runA.runId);
    expect(remainingOf(lot1)).toBeUndefined();
    expect(remainingRunOf(lot1)).toBeUndefined();
  });

  /**
   * THE DETACHED-SALE RESIDUE — a revert that reports success while leaving a
   * wrong basis behind.
   *
   * A sale that fits inside ONE lot is assigned straight to the user's own
   * split, with no generated sub-split to tag; the average run records its
   * basis in `avg_cost_basis` on that user split. Reverting the run deleted
   * the slot but left the split attached to the lot, so the closed lot went on
   * reporting a sale — now priced off the lot's own $100 buy instead of the
   * $200 pooled basis. $300 of gain on a Form 8949 line the user had already
   * seen at $200, from an operation that reported success.
   *
   * `avgArtifacts.splitGuids` names that split exactly, so the revert can
   * clear its `lot_guid` — no `gnucash_web_generated` tag on a user row, and
   * no user row deleted.
   */
  it('detaches the sale it priced instead of leaving it on the lot at per-lot basis', async () => {
    addTrade('2024-01-01', 10, 100);           // 10 sh @ $10.00
    addTrade('2024-06-01', 10, 300);           // 10 sh @ $30.00
    await autoAssignLots(STOCK_ACCT, 'average');

    // Run B prices one 10-share sale against the pool: 20 sh / $400 ⇒
    // $20.00/sh ⇒ basis $200, proceeds $400, gain $200.
    const sellGuid = addTrade('2024-07-01', -10, 400);
    const runB = await autoAssignLots(STOCK_ACCT, 'average');
    const saleLot = lotOfSplit(sellGuid)!;
    expect(avgBasisOf(sellGuid)).toBeCloseTo(200, 6);
    expect(avgRunOf(sellGuid)).toBe(runB.runId);
    // The shape that produces the residue: the split carrying the basis is the
    // user's own, and nothing tagged it.
    expect(generatedFor(runB.runId).some(s => s.obj_guid === sellGuid)).toBe(false);

    const filed = (await getAccountLots(STOCK_ACCT)).find(l => l.guid === saleLot)!;
    expect(lotToRealizedSales(filed, 'AAPL')[0].costBasis).toBeCloseTo(200, 6);
    expect(filed.realizedGain).toBeCloseTo(200, 6);

    const result = await revertScrubRun(runB.runId);
    expect(result.reverted).toBeGreaterThan(0);

    // THE ASSERTION: the run that reported success left no sale behind at all
    // — and above all not one priced at the first lot's own $100.
    expect(lotOfSplit(sellGuid)).toBeNull();
    const after = await getAccountLots(STOCK_ACCT);
    const salesAfter = after.flatMap(l => lotToRealizedSales(l, 'AAPL'));
    expect(salesAfter).toHaveLength(0);
    expect(salesAfter.some(s => Math.abs(s.costBasis - 100) < 0.01)).toBe(false);
    expect(after.every(l => Math.abs(l.realizedGain) < 0.01)).toBe(true);

    // The lot the sale had closed holds its 10 bought shares again.
    const reopened = after.find(l => l.guid === saleLot)!;
    expect(reopened.isClosed).toBe(false);
    expect(reopened.totalShares).toBeCloseTo(10, 6);
  });

  /**
   * The history used to live in `slots.string_val`, a VARCHAR(4096), which
   * capped it at roughly 48-80 writes per lot; past that the OLDEST entries
   * were dropped with a `console.warn` and reverting an old run fell back to
   * per-lot basis. The durable table has no such ceiling.
   */
  it('keeps every write, far past the old ~48-80 entry slot ceiling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lot = 'lot-deep-history';
    const stack = Array.from({ length: 500 }, (_, i) => ({
      run: `run-${String(i).padStart(28, '0')}`,
      value: String(1000 + i),
    }));

    await writeAvgBasisWrites(lot, stack, fakePrisma as unknown as PrismaTx);

    // Not one entry given up, and nothing warned about - the two symptoms of
    // the column bound.
    const kept = writeHistory(lot);
    expect(kept).toHaveLength(500);
    expect(kept[0]).toEqual({ run: stack[0].run, value: '1000' });
    expect(kept[499]).toEqual({ run: stack[499].run, value: '1499' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();

    // The live slot still mirrors the top, so every reader is untouched.
    expect(remainingOf(lot)).toBeCloseTo(1499, 6);
    expect(remainingRunOf(lot)).toBe(stack[499].run);
    // And the legacy JSON slot is not written at all any more.
    expect(rawSlotOf(lot, 'avg_cost_basis_remaining_prev')).toBeUndefined();

    // The oldest entry is still restorable, which is the whole point: at the
    // old bound this run's value had been dropped and the revert fell through
    // to per-lot basis.
    const tx = fakePrisma as unknown as PrismaTx;
    await writeAvgBasisWrites(lot, kept.filter(e => e.run !== stack[499].run), tx);
    expect(remainingOf(lot)).toBeCloseTo(1498, 6);
    await writeAvgBasisWrites(lot, [stack[0]], tx);
    expect(remainingOf(lot)).toBeCloseTo(1000, 6);
  });

  /**
   * One row per write, not one JSON document: a damaged entry costs that entry
   * and nothing else. Under the JSON stash a single bad character made
   * `JSON.parse` throw and the decoder returned NOTHING - one byte erased the
   * whole stack.
   */
  it('a damaged deep entry costs one entry, not the whole stack', async () => {
    const tx = fakePrisma as unknown as PrismaTx;
    const lot = 'lot-damaged-entry';
    const stack = [
      { run: 'run-aaaa', value: '1000' },
      { run: 'run-bbbb', value: '2000' },
      { run: 'run-cccc', value: '3000' },
      { run: 'run-dddd', value: '4000' },
    ];
    await writeAvgBasisWrites(lot, stack, tx);

    // Damage one row in the middle, the way a bad byte would.
    avgBasisHistory.rows.find(r => r.lot_guid === lot && r.seq_no === 1)!.basis_val = '20 00';

    const read = await readAvgBasisWrites(lot, tx);
    expect(read).toHaveLength(4);
    expect(read.map(e => e.run)).toEqual(['run-aaaa', 'run-bbbb', 'run-cccc', 'run-dddd']);
    expect(read[1].corrupt).toBe(true);
    // Every OTHER write is intact and still usable.
    expect(read.filter(e => e.corrupt).length).toBe(1);
    expect(read[0].value).toBe('1000');
    expect(read[3].value).toBe('4000');

    // And the live value is untouched: readers never saw the damage.
    expect(remainingOf(lot)).toBeCloseTo(4000, 6);

    // Reverting the run ABOVE the damaged entry still lands on a good value.
    await writeAvgBasisWrites(lot, read.filter(e => e.run !== 'run-dddd'), tx);
    expect(remainingOf(lot)).toBeCloseTo(3000, 6);
  });

  /**
   * When the value that would become LIVE is the damaged one, there is no
   * honest number left. The old code wrote it anyway; every reader then failed
   * to parse it and fell through to the lot's own purchase cost - a wrong
   * basis on Form 8949, from an operation that reported success.
   */
  it('raises a repair-required error rather than materializing a damaged write', async () => {
    const tx = fakePrisma as unknown as PrismaTx;
    const lot = 'lot-damaged-top';
    await writeAvgBasisWrites(lot, [
      { run: 'run-aaaa', value: '1000' },
      { run: 'run-bbbb', value: '2000' },
    ], tx);
    avgBasisHistory.rows.find(r => r.lot_guid === lot && r.seq_no === 0)!.basis_val = 'not-a-number';

    const stack = await readAvgBasisWrites(lot, tx);
    // Reverting run B would put the damaged entry on top.
    await expect(
      writeAvgBasisWrites(lot, stack.filter(e => e.run !== 'run-bbbb'), tx),
    ).rejects.toThrow(AvgBasisHistoryRepairRequiredError);

    // Nothing was half-written: the live value is still run B's.
    expect(remainingOf(lot)).toBeCloseTo(2000, 6);
  });

  /**
   * The other unrecoverable shape: the history survives but the live value is
   * gone. Falling back to the lot's own purchase cost double-counts basis an
   * earlier run's disposal slot already says was spent.
   */
  it('refuses to seed the pool from per-lot cost when a priced lot lost its live value', async () => {
    const buyGuid = addTrade('2024-01-01', 10, 1000);
    await autoAssignLots(STOCK_ACCT, 'average');
    const lot = lotOfSplit(buyGuid)!;
    expect(remainingOf(lot)).toBeCloseTo(1000, 6);

    // The mirror is destroyed out of band; the durable history stands.
    db.slots = db.slots.filter(
      s => !(s.obj_guid === lot && String(s.name).startsWith('avg_cost_basis_remaining')),
    );
    expect(writeHistory(lot).length).toBeGreaterThan(0);

    await expect(
      readLiveAvgBasisRemaining(lot, fakePrisma as unknown as PrismaTx),
    ).rejects.toThrow(/cannot be read/);

    // A lot the average method has never seen is NOT an error - that is the
    // case the per-lot fallback is correct for.
    const virginLot = 'lot-never-averaged';
    db.lots.push({ guid: virginLot, account_guid: STOCK_ACCT, is_closed: 0 });
    await expect(
      readLiveAvgBasisRemaining(virginLot, fakePrisma as unknown as PrismaTx),
    ).resolves.toBeNull();
  });

  /**
   * A book written by an older deploy carries its stack in the legacy JSON
   * slot. It must be carried into the table, not abandoned - the bulk
   * migration in db-init.ts does the same thing set-based at startup.
   */
  it('adopts a legacy JSON-slot history on first read, then stops reading the slot', async () => {
    const tx = fakePrisma as unknown as PrismaTx;
    const lot = 'lot-legacy-json';
    db.lots.push({ guid: lot, account_guid: STOCK_ACCT, is_closed: 0 });
    db.slots.push(
      {
        obj_guid: lot, name: 'avg_cost_basis_remaining_prev', slot_type: 4,
        string_val: JSON.stringify([
          { run: 'run-old-a', value: '1000' },
          { run: 'run-old-b', value: '2000' },
        ]),
      },
      { obj_guid: lot, name: 'avg_cost_basis_remaining', slot_type: 4, string_val: '3000' },
      { obj_guid: lot, name: 'avg_cost_basis_remaining_run', slot_type: 4, string_val: 'run-old-c' },
    );

    const adopted = await readAvgBasisWrites(lot, tx);
    expect(adopted).toEqual([
      { run: 'run-old-a', value: '1000' },
      { run: 'run-old-b', value: '2000' },
      { run: 'run-old-c', value: '3000' },
    ]);
    // Carried into the table, and the legacy slot dropped so there is never a
    // second source of truth for a filed number.
    expect(writeHistory(lot)).toHaveLength(3);
    expect(rawSlotOf(lot, 'avg_cost_basis_remaining_prev')).toBeUndefined();
    // The live mirror is untouched by adoption.
    expect(remainingOf(lot)).toBeCloseTo(3000, 6);

    // A later run stacks on top of the adopted history rather than beside it.
    await writeAvgBasisRemaining(lot, 4000, 'run-new-d', tx);
    expect(writeHistory(lot).map(e => e.run)).toEqual([
      'run-old-a', 'run-old-b', 'run-old-c', 'run-new-d',
    ]);
  });

  it('run-scoped cleanup only ever deletes SLOTS, never the user’s split', async () => {
    addTrade('2024-01-01', 20, 400);
    await autoAssignLots(STOCK_ACCT, 'average');
    const sellGuid = addTrade('2024-09-01', -5, 200);
    const runB = await autoAssignLots(STOCK_ACCT, 'average');

    // The property the whole design hangs on: the run id sits in a slot NAME
    // the generated-entity sweep never queries, so the user's own sell split
    // is never enumerated as a generated row to delete.
    expect(generatedFor(runB.runId).some(s => s.obj_guid === sellGuid)).toBe(false);

    await revertScrubRun(runB.runId);

    const survivor = db.splits.find(s => s.guid === sellGuid);
    expect(survivor).toBeDefined();
    expect(Number(survivor!.quantity_num)).toBe(-500);
    expect(Number(survivor!.value_num)).toBe(-20000);
  });
});
