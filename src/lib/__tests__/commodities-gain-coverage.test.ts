/**
 * The gain a partly-covered holding reports.
 *
 * `costBasis` is the basis of the shares that HAVE one. Subtracting it from the
 * whole position's market value — which is what `marketValue - costBasis` did —
 * credits every uncovered share with pure profit, so the gain and the gain %
 * are overstated with nothing said about it. The numbers below are the ones a
 * user was shown before this change and the ones they are shown now.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAccountsFindUnique = vi.fn();
const mockSplitsFindMany = vi.fn();
const mockPricesFindFirst = vi.fn();
const mockTraceCostBasis = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    accounts: { findUnique: (...args: unknown[]) => mockAccountsFindUnique(...args) },
    splits: { findMany: (...args: unknown[]) => mockSplitsFindMany(...args) },
    prices: { findFirst: (...args: unknown[]) => mockPricesFindFirst(...args) },
  },
}));

// Only the trace is stubbed — the pool helpers and gain math are the real ones.
vi.mock('../cost-basis', async (importActual) => {
  const actual = await importActual<typeof import('../cost-basis')>();
  return {
    ...actual,
    traceCostBasis: (...args: unknown[]) => mockTraceCostBasis(...args),
  };
});

import {
  getAccountHoldings,
  calculateGainLoss,
  calculateGainLossPercent,
  combineCoverage,
  combinePositionSide,
  positionSideBasisLabel,
  sameCoverageStatement,
  totalHoldings,
  UNTRACED_BASIS_COVERAGE,
} from '../commodities';

const AAPL = 'commodity-aapl';
const USD = 'commodity-usd';
const ACCT = 'acct-holding';
const OTHER = 'acct-other-brokerage';

/** $50.00 a share, so 200 shares are worth $10,000. */
const PRICE = 50;

function frac(n: number) {
  return { num: BigInt(Math.round(n * 10_000)), denom: 10_000n };
}

function row(o: {
  guid: string; txGuid: string; postDate: string; shares: number; value: number;
  counterAccount: string; counterCommodity: string;
}) {
  const q = frac(o.shares);
  const v = frac(o.value);
  const self = {
    guid: o.guid, tx_guid: o.txGuid, account_guid: ACCT, lot_guid: null,
    quantity_num: q.num, quantity_denom: q.denom, value_num: v.num, value_denom: v.denom,
    account: { guid: ACCT, commodity_guid: AAPL, account_type: 'STOCK' },
  };
  const counterQty = frac(o.counterCommodity === USD ? -o.value : -o.shares);
  const counter = {
    guid: `${o.guid}-counter`, tx_guid: o.txGuid, account_guid: o.counterAccount, lot_guid: null,
    quantity_num: counterQty.num, quantity_denom: counterQty.denom,
    value_num: frac(-o.value).num, value_denom: frac(-o.value).denom,
    account: { guid: o.counterAccount, commodity_guid: o.counterCommodity, account_type: 'BANK' },
  };
  return {
    ...self,
    transaction: { post_date: new Date(`${o.postDate}T12:00:00.000Z`), splits: [self, counter] },
  };
}

const buy = (o: { guid: string; postDate: string; shares: number; value: number }) =>
  row({ ...o, txGuid: `tx-${o.guid}`, counterAccount: 'acct-cash', counterCommodity: USD });

const transferIn = (o: { guid: string; postDate: string; shares: number }) =>
  row({ ...o, txGuid: `tx-${o.guid}`, value: 0, counterAccount: OTHER, counterCommodity: AAPL });

beforeEach(() => {
  mockAccountsFindUnique.mockReset();
  mockSplitsFindMany.mockReset();
  mockPricesFindFirst.mockReset();
  mockTraceCostBasis.mockReset();
  mockAccountsFindUnique.mockResolvedValue({
    guid: ACCT, commodity_guid: AAPL, commodity_scu: 10_000,
    commodity: { guid: AAPL, mnemonic: 'AAPL' },
  });
  mockPricesFindFirst.mockResolvedValue({
    guid: 'price-1', date: new Date('2026-08-14T00:00:00.000Z'),
    value_num: BigInt(PRICE * 10_000), value_denom: 10_000n, source: 'user:price',
  });
});

/**
 * 200 shares: 100 bought for $1,000, plus a 100-share transfer-in that traces
 * to $2,500 of basis covering only 50 of them. Basis $3,500 over 150 covered
 * shares; 50 shares have no establishable basis. At $50 a share the position is
 * worth $10,000.
 */
function partiallyCoveredHolding() {
  mockSplitsFindMany.mockResolvedValue([
    buy({ guid: 'buy-1', postDate: '2020-01-01', shares: 100, value: 1_000 }),
    transferIn({ guid: 'xfer-1', postDate: '2021-01-01', shares: 100 }),
  ]);
  mockTraceCostBasis.mockResolvedValue({
    coveredShares: 50,
    uncoveredShares: 50,
    basisOfCoveredShares: 2_500,
    perShareCost: 50,
    method: 'fifo',
    warnings: ['50 of 100 share(s) transferred in on 2021-01-01 have no traceable cost basis in this book.'],
  });
}

describe('gain against a partial cost basis', () => {
  it('does NOT report the whole position gain against the covered basis', async () => {
    partiallyCoveredHolding();
    const h = await getAccountHoldings(ACCT, undefined, { enabled: true, method: 'fifo' });

    expect(h.shares).toBeCloseTo(200, 6);
    expect(h.costBasis).toBeCloseTo(3_500, 6);
    expect(h.marketValue).toBeCloseTo(10_000, 6); // every share, covered or not

    // BEFORE: marketValue - costBasis = $10,000 - $3,500 = $6,500, at 185.71%.
    // That is the number this change removes: it credits all 200 shares'
    // market value against 150 shares' basis, so the 50 shares with no basis
    // read as $2,500 of pure profit.
    const overstatedGain = h.marketValue - h.costBasis;
    expect(overstatedGain).toBeCloseTo(6_500, 6);
    expect((overstatedGain / h.costBasis) * 100).toBeCloseTo(185.7142857, 5);
    expect(h.gainLoss).not.toBeCloseTo(6_500, 2);
    expect(h.gainLossPercent).not.toBeCloseTo(185.71, 2);

    // AFTER: both sides describe the same 150 shares —
    // 150 x $50 = $7,500 of market value against $3,500 of basis = $4,000,
    // which is 114.29%. The $2,500 difference is exactly the market value of
    // the 50 uncovered shares.
    expect(h.gainLoss).toBeCloseTo(4_000, 6);
    expect(h.gainLossPercent).toBeCloseTo(114.2857142, 5);
    expect(overstatedGain - h.gainLoss).toBeCloseTo(2_500, 6);

    // And the caveat travels with it, naming the shares left out.
    if (h.costBasisCoverage.status !== 'partial') throw new Error('expected partial coverage');
    expect(h.costBasisCoverage.coveredShares).toBeCloseTo(150, 6);
    expect(h.costBasisCoverage.uncoveredShares).toBeCloseTo(50, 6);
    expect(h.costBasisCoverage.warnings[0]).toContain('no traceable cost basis');
  });

  it('a fully covered holding reports exactly what it does today', async () => {
    // 100 bought for $1,000 plus a transfer-in of 100 that traces in full for
    // $5,000: $6,000 of basis over all 200 shares, worth $10,000.
    mockSplitsFindMany.mockResolvedValue([
      buy({ guid: 'buy-1', postDate: '2020-01-01', shares: 100, value: 1_000 }),
      transferIn({ guid: 'xfer-1', postDate: '2021-01-01', shares: 100 }),
    ]);
    mockTraceCostBasis.mockResolvedValue({
      coveredShares: 100, uncoveredShares: 0, basisOfCoveredShares: 5_000,
      perShareCost: 50, method: 'fifo',
    });

    const h = await getAccountHoldings(ACCT, undefined, { enabled: true, method: 'fifo' });

    expect(h.costBasis).toBeCloseTo(6_000, 6);
    expect(h.marketValue).toBeCloseTo(10_000, 6);
    // Unchanged from the plain subtraction: $10,000 - $6,000 = $4,000 at 66.67%.
    expect(h.gainLoss).toBeCloseTo(h.marketValue - h.costBasis, 6);
    expect(h.gainLoss).toBeCloseTo(4_000, 6);
    expect(h.gainLossPercent).toBeCloseTo(66.6666666, 5);
    expect(h.costBasisCoverage).toEqual({ status: 'complete', coveredShares: 200 });
  });

  it('a closed position still reports zeros', async () => {
    mockSplitsFindMany.mockResolvedValue([
      buy({ guid: 'buy-1', postDate: '2020-01-01', shares: 100, value: 1_000 }),
      row({
        guid: 'sell-1', txGuid: 'tx-sell-1', postDate: '2024-01-01', shares: -100, value: -9_000,
        counterAccount: 'acct-cash', counterCommodity: USD,
      }),
    ]);

    const h = await getAccountHoldings(ACCT, undefined, { enabled: true, method: 'fifo' });
    expect(h.shares).toBe(0);
    expect(h.costBasis).toBe(0);
    expect(h.marketValue).toBe(0);
    expect(h.gainLoss).toBe(0);
    expect(h.gainLossPercent).toBe(0);
  });
});

describe('calculateGainLoss', () => {
  it('restricts market value to the covered shares under partial coverage', () => {
    const gain = calculateGainLoss({
      shares: 200,
      pricePerShare: PRICE,
      costBasis: 3_500,
      coverage: { status: 'partial', coveredShares: 150, uncoveredShares: 50, warnings: [] },
    });
    expect(gain).toBeCloseTo(4_000, 6);                       // 150 x $50 - $3,500
    expect(calculateGainLossPercent(gain, 3_500)).toBeCloseTo(114.2857142, 5);
  });

  it('values the whole position under complete coverage', () => {
    const gain = calculateGainLoss({
      shares: 200,
      pricePerShare: PRICE,
      costBasis: 6_000,
      coverage: { status: 'complete', coveredShares: 200 },
    });
    expect(gain).toBeCloseTo(4_000, 6);                       // 200 x $50 - $6,000
  });

  it('values the whole position under unknown coverage — there is no subset to restrict to', () => {
    // Nothing is known to be missing, so nothing can be excluded; the number is
    // the best available and its caveat rides along in the coverage.
    const gain = calculateGainLoss({
      shares: 200,
      pricePerShare: PRICE,
      costBasis: 3_500,
      coverage: UNTRACED_BASIS_COVERAGE,
    });
    expect(gain).toBeCloseTo(6_500, 6);
    expect(UNTRACED_BASIS_COVERAGE.status).toBe('unknown');
  });
});

describe('combineCoverage', () => {
  it('sums partial coverage across accounts and dedupes the warnings', () => {
    const combined = combineCoverage([
      { status: 'complete', coveredShares: 100 },
      { status: 'partial', coveredShares: 50, uncoveredShares: 50, warnings: ['no traceable cost basis'] },
      { status: 'partial', coveredShares: 10, uncoveredShares: 5, warnings: ['no traceable cost basis'] },
    ]);
    expect(combined).toEqual({
      status: 'partial',
      coveredShares: 160,
      uncoveredShares: 55,
      warnings: ['no traceable cost basis'],
    });
  });

  it('one unknown part makes the whole total unknown', () => {
    const combined = combineCoverage([
      { status: 'complete', coveredShares: 100 },
      UNTRACED_BASIS_COVERAGE,
      { status: 'partial', coveredShares: 50, uncoveredShares: 50, warnings: [] },
    ]);
    expect(combined.status).toBe('unknown');
  });

  it('all-complete parts stay complete', () => {
    expect(combineCoverage([
      { status: 'complete', coveredShares: 100 },
      { status: 'complete', coveredShares: 25 },
    ])).toEqual({ status: 'complete', coveredShares: 125 });
  });
});

describe('totalHoldings', () => {
    /**
     * The account view's summary card sits directly above the holdings rows it
     * totals. Holding A is the partly covered one from above ($10,000 of market
     * value, $3,500 of basis over 150 of 200 shares, $4,000 of covered gain);
     * holding B is fully covered ($5,000 against $2,000, a $3,000 gain).
     */
    const HOLDINGS = [
        {
            costBasis: 3_500,
            costBasisCoverage: {
                status: 'partial' as const, coveredShares: 150, uncoveredShares: 50, warnings: [],
            },
            marketValue: 10_000,
            gainLoss: 4_000,
        },
        {
            costBasis: 2_000,
            costBasisCoverage: { status: 'complete' as const, coveredShares: 100 },
            marketValue: 5_000,
            gainLoss: 3_000,
        },
    ];

    it('sums the covered gains instead of subtracting the totals', () => {
        const totals = totalHoldings(HOLDINGS);

        expect(totals.totalValue).toBeCloseTo(15_000, 6);
        expect(totals.totalCostBasis).toBeCloseTo(5_500, 6);

        // BEFORE: totalValue - totalCostBasis = $15,000 - $5,500 = $9,500,
        // printed above rows reading $4,000 and $3,000 — a total that
        // disagreed with the sum of its own visible rows by exactly the
        // $2,500 market value of the 50 uncovered shares.
        expect(totals.totalValue - totals.totalCostBasis).toBeCloseTo(9_500, 6);
        expect(totals.totalGainLoss).not.toBeCloseTo(9_500, 2);

        // AFTER: $4,000 + $3,000.
        expect(totals.totalGainLoss).toBeCloseTo(7_000, 6);
        expect(totals.totalGainLoss).toBeCloseTo(
            HOLDINGS.reduce((sum, h) => sum + h.gainLoss, 0), 6,
        );
        expect(totals.totalGainLossPercent).toBeCloseTo(127.2727272, 5);
    });

    it('carries the pooled coverage so the card can caveat itself', () => {
        expect(totalHoldings(HOLDINGS).totalCostBasisCoverage).toEqual({
            status: 'partial', coveredShares: 250, uncoveredShares: 50, warnings: [],
        });
    });

    it('a fully covered set totals exactly as a plain subtraction would', () => {
        const totals = totalHoldings([
            {
                costBasis: 6_000,
                costBasisCoverage: { status: 'complete', coveredShares: 200 },
                marketValue: 10_000,
                gainLoss: 4_000,
            },
            {
                costBasis: 2_000,
                costBasisCoverage: { status: 'complete', coveredShares: 100 },
                marketValue: 5_000,
                gainLoss: 3_000,
            },
        ]);

        expect(totals.totalGainLoss).toBeCloseTo(totals.totalValue - totals.totalCostBasis, 6);
        expect(totals.totalGainLoss).toBeCloseTo(7_000, 6);
        expect(totals.totalCostBasisCoverage).toEqual({ status: 'complete', coveredShares: 300 });
    });

    it('an empty set is complete and zero, not unknown', () => {
        expect(totalHoldings([])).toEqual({
            totalValue: 0,
            totalCostBasis: 0,
            totalCostBasisCoverage: { status: 'complete', coveredShares: 0 },
            totalGainLoss: 0,
            totalGainLossPercent: 0,
        });
    });
});

describe('sameCoverageStatement', () => {
    const partial = (coveredShares: number, uncoveredShares: number) =>
        ({ status: 'partial' as const, coveredShares, uncoveredShares, warnings: [] });

    it('two partial coverages with different counts do NOT agree', () => {
        // The discriminant tag is the same and the meaning is not: a surface
        // that discloses one statement on behalf of both misdescribes both.
        expect(sameCoverageStatement(partial(150, 50), partial(10, 890))).toBe(false);
        expect(sameCoverageStatement(partial(150, 50), partial(150, 60))).toBe(false);
        expect(sameCoverageStatement(partial(150, 50), partial(150, 50))).toBe(true);
    });

    it('unknown coverages agree only when they give the same reason', () => {
        expect(sameCoverageStatement(UNTRACED_BASIS_COVERAGE, UNTRACED_BASIS_COVERAGE)).toBe(true);
        expect(sameCoverageStatement(
            UNTRACED_BASIS_COVERAGE,
            { status: 'unknown', reason: 'The share balance and the pool disagree.' },
        )).toBe(false);
    });

    it('complete coverages always agree — there is nothing to state', () => {
        expect(sameCoverageStatement(
            { status: 'complete', coveredShares: 200 },
            { status: 'complete', coveredShares: 7 },
        )).toBe(true);
        expect(sameCoverageStatement({ status: 'complete', coveredShares: 200 }, partial(150, 50))).toBe(false);
    });
});

describe('calculateGainLoss — short positions', () => {
    /**
     * A short position's basis is the PROCEEDS already received, so its gain is
     * `proceeds - price x |shares|`: it makes money as the price falls. Running
     * the long subtraction over the same inputs returns the exact negation,
     * which is a plausible-looking number and therefore the dangerous kind of
     * wrong.
     */
    const SHORT_COVERAGE = { status: 'complete' as const, coveredShares: 50 };

    it('gains when the price falls below the short price', () => {
        expect(calculateGainLoss({
            shares: -50, pricePerShare: 60, costBasis: 4_000,
            coverage: SHORT_COVERAGE, positionSide: 'short',
        })).toBeCloseTo(1_000, 9);
    });

    it('loses when the price rises above it', () => {
        expect(calculateGainLoss({
            shares: -50, pricePerShare: 100, costBasis: 4_000,
            coverage: SHORT_COVERAGE, positionSide: 'short',
        })).toBeCloseTo(-1_000, 9);
    });

    it('is nothing like what the long formula reports for the same row', () => {
        // The long subtraction runs a NEGATIVE share count through
        // `shares x price`, so it double-counts the sign: -50 x 60 - 4,000 =
        // -$7,000 where the position is in fact $1,000 up.
        const inputs = { shares: -50, pricePerShare: 60, costBasis: 4_000, coverage: SHORT_COVERAGE };
        expect(calculateGainLoss(inputs)).toBeCloseTo(-7_000, 9);
        expect(calculateGainLoss({ ...inputs, positionSide: 'short' })).toBeCloseTo(1_000, 9);
    });

    it('defaults to the long formula, so existing callers are untouched', () => {
        expect(calculateGainLoss({
            shares: 200, pricePerShare: 50, costBasis: 3_500,
            coverage: { status: 'complete', coveredShares: 200 },
        })).toBeCloseTo(6_500, 9);
    });
});

describe('combinePositionSide', () => {
    it('reports long and short legs together as mixed, never as one side', () => {
        expect(combinePositionSide(['long', 'short'])).toBe('mixed');
        expect(combinePositionSide(['long', 'flat', 'mixed'])).toBe('mixed');
    });

    it('keeps a pure side, and an empty or flat group is flat', () => {
        expect(combinePositionSide(['long', 'long', 'flat'])).toBe('long');
        expect(combinePositionSide(['short', 'flat'])).toBe('short');
        expect(combinePositionSide(['flat', 'flat'])).toBe('flat');
        expect(combinePositionSide([])).toBe('flat');
    });

    it('labels only the sides that are not a purchase cost', () => {
        expect(positionSideBasisLabel('long')).toBeNull();
        expect(positionSideBasisLabel('flat')).toBeNull();
        expect(positionSideBasisLabel(undefined)).toBeNull();
        expect(positionSideBasisLabel('short')).toBe('short basis (proceeds)');
        expect(positionSideBasisLabel('mixed')).toBe('includes short legs (proceeds)');
    });
});
