/**
 * Capital-Gains Tax Forms — IRS Form 8949 / Schedule D
 *
 * Builds Form-8949 rows from realized (closed / partially-closed) stock and
 * mutual-fund lots, groups them into the six 8949 buckets (Part I short-term
 * boxes A/B/C, Part II long-term boxes D/E/F), and rolls the buckets up into
 * a Schedule D summary. Also reconciles the computed sales against broker
 * 1099-B rows.
 *
 * Design notes / caveats:
 *  - Broker-reported basis status is NOT stored in GnuCash, so every row
 *    defaults to "basis NOT reported to the IRS" — short-term Box C and
 *    long-term Box F. A 1099-B reconciliation match can upgrade a row to
 *    "basis reported" (Box A / Box D) by setting `basisReported`. Boxes B/E
 *    (reported on a 1099-B but with basis not reported) are not emitted; we
 *    only distinguish reported (A/D) vs. not-reported (C/F).
 *  - Holding term is recomputed here from the acquired/sold dates rather than
 *    reusing LotSummary.holdingPeriod, because that field measures the holding
 *    period against *today* — wrong for a lot that was already closed in a
 *    prior year. IRS "more than one year" is applied strictly (see isLongTerm).
 *  - dateAcquired falls back openDate -> earliest buy split when the lot has no
 *    acquisition_date slot (untransferred lots).
 *  - Brokerage commissions and fees are recorded by GnuCash as separate
 *    EXPENSE splits of the trade transaction, so they are invisible to the
 *    lot's own splits. loadRealizedSales recovers them (@/lib/trade-fees) and
 *    applies the IRS treatment: buy-side fees capitalize into basis, sell-side
 *    fees reduce the amount realized. Both shrink the reported gain, and
 *    proceeds then line up with a 1099-B's net box-1d figure.
 *
 * The row-building math is PURE (no DB, no clock) so it can be unit-tested;
 * DB loading lives in the separate loadRealizedSales / loadCapitalGainsReport
 * functions at the bottom.
 */

import type { LotSummary } from '@/lib/lots';
import type { WashSaleResult } from '@/lib/lot-assignment';
import { escapeCSVField } from '@/lib/reports/csv-export';
import { isLongTerm, computeTerm, type Term } from '@/lib/holding-period';
import { NO_TRADE_FEES, type TradeFeeBySplit } from '@/lib/trade-fees';
import { BROKER_PROCEEDS_MATCH_TOLERANCE, MONEY_DISPLAY_EPSILON } from '@/lib/tolerances';

// The IRS holding-period rule lives in @/lib/holding-period (single source of
// truth, shared with the lot-scrub engine and the tax estimator); re-exported
// here for the report surfaces that historically imported it from this module.
export { isLongTerm, computeTerm };
export type { Term };

const EPS = 0.0001;
export type Form8949Box = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/** One realized disposal, before wash-sale / bucketing logic is applied. */
export interface RealizedSaleInput {
  /** GnuCash GUID of the stock-account split that disposed of these shares. */
  splitGuid: string;
  accountGuid: string;
  ticker: string;
  shares: number;          // shares sold (positive)
  dateAcquired: string;    // ISO date
  dateSold: string;        // ISO date
  /** NET of the disposal's brokerage commissions/fees (see lotToRealizedSales). */
  proceeds: number;
  /** INCLUDES the acquisition's capitalized commissions/fees. */
  costBasis: number;
  /** Set true once a 1099-B match confirms the broker reported basis. */
  basisReported?: boolean;
}

/** A completed Form-8949 line. */
export interface Form8949Row {
  description: string;     // "10 AAPL"
  ticker: string;
  accountGuid: string;
  shares: number;          // shares sold (positive)
  dateAcquired: string;    // ISO
  dateSold: string;        // ISO
  proceeds: number;        // (d)
  costBasis: number;       // (e)
  code: string;            // (f) '' or 'W'
  adjustment: number;      // (g) wash-sale disallowed amount (>= 0)
  gain: number;            // (h) proceeds - costBasis + adjustment
  term: Term;
  basisReported: boolean;
  box: Form8949Box;
  /**
   * True when this row's implied per-share price is wildly inconsistent with
   * other sales of the same security — a signal of a corrupt underlying
   * transaction, not a real gain/loss. The figures are still reported (we do
   * not silently alter the book) but flagged for review before filing.
   */
  suspect?: boolean;
  suspectReason?: string;
}

export interface Form8949Bucket {
  box: Form8949Box;
  part: 'I' | 'II';
  term: Term;
  basisReported: boolean;
  label: string;
  rows: Form8949Row[];
  totals: TermTotals;
}

export interface TermTotals {
  proceeds: number;
  costBasis: number;
  adjustments: number;
  gain: number;
}

export interface ScheduleDSummary {
  shortTerm: TermTotals;
  longTerm: TermTotals;
  netShortTerm: number;
  netLongTerm: number;
  net: number;
}

export interface CapitalGainsReport {
  year: number;
  rows: Form8949Row[];
  buckets: Form8949Bucket[];
  scheduleD: ScheduleDSummary;
  /** Human-readable warnings, e.g. suspect rows worth reviewing before filing. */
  warnings: string[];
}

/**
 * Factor by which a row's implied per-share price may diverge from the
 * same-security median before it is flagged as suspect. A normal security
 * does not sell at 5× different prices within one tax year, so a larger
 * divergence almost always means a corrupt underlying transaction.
 */
const SUSPECT_PRICE_FACTOR = 5;

/**
 * Flag rows whose implied per-share price is wildly inconsistent with other
 * sales of the same security in the same report. Pure; mutates the passed rows'
 * suspect fields and returns the warning strings. Rows with zero shares or
 * non-positive proceeds are ignored for the median but can still be flagged if
 * a sibling establishes a sane price.
 */
export function flagSuspectRows(rows: Form8949Row[]): string[] {
  const warnings: string[] = [];
  const byTicker = new Map<string, Form8949Row[]>();
  for (const row of rows) {
    const list = byTicker.get(row.ticker);
    if (list) list.push(row);
    else byTicker.set(row.ticker, [row]);
  }

  for (const [ticker, group] of byTicker) {
    const prices = group
      .filter(r => Math.abs(r.shares) > 1e-9 && Math.abs(r.proceeds) > 1e-9)
      .map(r => Math.abs(r.proceeds / r.shares))
      .sort((a, b) => a - b);
    if (prices.length < 2) continue; // need siblings to establish a norm

    const median = prices[Math.floor(prices.length / 2)];
    if (median <= 0) continue;

    for (const row of group) {
      if (Math.abs(row.shares) <= 1e-9) continue;
      const price = Math.abs(row.proceeds / row.shares);
      if (price <= 0) continue;
      const ratio = price / median;
      if (ratio > SUSPECT_PRICE_FACTOR || ratio < 1 / SUSPECT_PRICE_FACTOR) {
        row.suspect = true;
        row.suspectReason =
          `Implied price $${price.toFixed(2)}/share is far from the ${ticker} ` +
          `median of $${median.toFixed(2)}/share — check the underlying transaction.`;
        warnings.push(
          `${ticker} sale on ${row.dateSold.slice(0, 10)}: ${row.suspectReason}`,
        );
      }
    }
  }
  return warnings;
}

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

/** Normalize an ISO / date string to its YYYY-MM-DD day. */
function toDay(dateStr: string): string {
  return dateStr.slice(0, 10);
}

/** Box the row lands in given its term + whether basis was broker-reported. */
export function boxFor(term: Term, basisReported: boolean): Form8949Box {
  if (term === 'short_term') return basisReported ? 'A' : 'C';
  return basisReported ? 'D' : 'F';
}

/** Trim a share count to at most 4 decimals with no trailing zeros. */
function formatShares(shares: number): string {
  return parseFloat(shares.toFixed(4)).toString();
}

/**
 * Extract the realized sales from a lot — one RealizedSaleInput PER SELL
 * SPLIT, closed and open (partially-sold) lots alike. PURE given the
 * LotSummary — no DB access.
 *
 * Per-sale rows (rather than one per-lot row) matter for three reasons the
 * 8949 report and the tax estimator both depend on:
 *  - YEAR attribution: a lot sold across multiple years realizes each sale's
 *    gain in that sale's year, not the whole gain in the close year.
 *  - Open lots: the realized portion of a partially-sold lot is reported.
 *  - Per-sale holding term: each sale's ST/LT is judged on its own sale date.
 *
 * Basis / proceeds use native GnuCash split signs: buys have positive value,
 * sells negative. Each sale realizes its shares' pro-rata slice of the lot's
 * basis pool = buy cost + carried basis. A transfer-destination lot's shares
 * arrive on a $0-value transfer-in split with the original cost carried in
 * the `carried_basis` lot slot (same formula as the scrub engine's
 * generateCapitalGains), and `acquisitionDate` carries the original purchase
 * date, so transferred lots keep their true basis and holding period.
 *
 * Zero-value share disposals are NOT sales and yield no row: an in-kind
 * TRANSFER-OUT split moves shares at $0 value (its basis travels to the
 * destination lot's carried_basis slot — not a taxable event), and the scrub
 * engine likewise refuses to book gains for zero-proceeds disposals
 * (unvalued trades). Either way there is no realized gain/loss to report.
 *
 * BROKERAGE COMMISSIONS: GnuCash books a commission as a separate EXPENSE
 * split of the trade transaction, invisible to the lot's own splits. `fees`
 * supplies the per-split amount recovered from those siblings (see
 * @/lib/trade-fees). Per IRS Pub. 550 a buy-side commission is capitalized
 * into basis and a sell-side commission reduces the amount realized, so a buy
 * fee joins the basis pool and a sell fee is subtracted from that sale's
 * proceeds. Omit `fees` (pure callers, tests) and the figures are gross, as
 * before.
 *
 * AVERAGE COST: a sale priced by the average-basis election carries its own
 * basis in `avgCostBasis` — the pool average as of THAT sale's date, which the
 * lot's pro-rata buy cost cannot reproduce (a later purchase re-averages the
 * pool, and a lot sold across several dates has a different basis per sale).
 * It is used verbatim and the lot's buy cost is not consulted. Buy-side
 * commissions are already capitalized into that figure at scrub time, so only
 * the sell-side fee is applied here; the date acquired and therefore the
 * short-vs-long-term split still come from the lot, which the replay consumes
 * oldest-first per Treas. Reg. §1.1012-1(e)(7)(ii).
 */
export function lotToRealizedSales(
  lot: LotSummary,
  ticker: string,
  fees: TradeFeeBySplit = NO_TRADE_FEES,
): RealizedSaleInput[] {
  const sells = lot.splits.filter(s => s.shares < -EPS);
  if (sells.length === 0) return [];

  // A carried-basis transfer-in's recorded value was replaced by the source
  // lot's basis. Keep this in lockstep with getLotsForAccounts so Form 8949
  // never counts both representations.
  const transferInSplitGuids = new Set(lot.transferInSplitGuids ?? []);
  const buys = lot.splits.filter(s => s.shares > EPS);
  const boughtShares = buys.reduce((sum, s) => sum + s.shares, 0);
  const basisBuys = buys.filter(s => !transferInSplitGuids.has(s.guid));
  const buyCost = basisBuys.reduce((sum, s) => sum + Math.abs(s.value), 0);
  const buyFees = basisBuys.reduce((sum, s) => sum + (fees.get(s.guid) ?? 0), 0);
  const basisPool = buyCost + (lot.carriedBasis ?? 0) + buyFees;
  const costPerShare = boughtShares > EPS ? basisPool / boughtShares : 0;

  // dateAcquired = acquisition slot -> open date -> earliest buy split
  const earliestBuy = buys.length > 0
    ? buys.reduce((earliest, s) => (s.postDate < earliest ? s.postDate : earliest), buys[0].postDate)
    : null;

  const sales: RealizedSaleInput[] = [];
  for (const sell of sells) {
    // The "is this a sale at all?" test stays on GROSS value: a transfer-out
    // is a $0-value disposal whatever fee rode along with it, and a fee must
    // never be what promotes a transfer into a reportable sale (or what makes
    // a real sale vanish by netting to ~0).
    const grossProceeds = -sell.value;
    if (Math.abs(grossProceeds) < MONEY_DISPLAY_EPSILON) continue; // transfer-out / unvalued trade
    const shares = Math.abs(sell.shares);
    sales.push({
      splitGuid: sell.guid,
      accountGuid: lot.accountGuid,
      ticker,
      shares,
      dateAcquired: lot.acquisitionDate || lot.openDate || earliestBuy || sell.postDate,
      dateSold: sell.postDate,
      proceeds: grossProceeds - (fees.get(sell.guid) ?? 0),
      costBasis: sell.avgCostBasis ?? shares * costPerShare,
    });
  }
  return sales;
}

/**
 * Find the wash-sale disallowed amount for a sale (>= 0), or 0 if none.
 * Matches the unique GnuCash disposal split GUID. WashSaleResult.loss is
 * stored negative; the disallowed adjustment is capped at the sale's actual
 * loss so a gain never flips positive.
 */
function washAdjustmentFor(
  sale: RealizedSaleInput,
  rawGain: number,
  washSales: WashSaleResult[],
): number {
  if (rawGain >= 0) return 0;
  const matches = washSales.filter(ws => ws.splitGuid === sale.splitGuid);
  if (matches.length === 0) return 0;
  const disallowed = matches.reduce((sum, match) => sum + Math.abs(match.loss), 0);
  return Math.min(disallowed, -rawGain);
}

function emptyTotals(): TermTotals {
  return { proceeds: 0, costBasis: 0, adjustments: 0, gain: 0 };
}

function addToTotals(t: TermTotals, row: Form8949Row): void {
  t.proceeds += row.proceeds;
  t.costBasis += row.costBasis;
  t.adjustments += row.adjustment;
  t.gain += row.gain;
}

const BUCKET_ORDER: Array<{
  box: Form8949Box;
  part: 'I' | 'II';
  term: Term;
  basisReported: boolean;
  label: string;
}> = [
  { box: 'A', part: 'I', term: 'short_term', basisReported: true, label: 'Part I — Box A (short-term, basis reported to IRS)' },
  { box: 'B', part: 'I', term: 'short_term', basisReported: false, label: 'Part I — Box B (short-term, basis reported on 1099-B but not to IRS)' },
  { box: 'C', part: 'I', term: 'short_term', basisReported: false, label: 'Part I — Box C (short-term, not reported on a 1099-B)' },
  { box: 'D', part: 'II', term: 'long_term', basisReported: true, label: 'Part II — Box D (long-term, basis reported to IRS)' },
  { box: 'E', part: 'II', term: 'long_term', basisReported: false, label: 'Part II — Box E (long-term, basis reported on 1099-B but not to IRS)' },
  { box: 'F', part: 'II', term: 'long_term', basisReported: false, label: 'Part II — Box F (long-term, not reported on a 1099-B)' },
];

/**
 * Build one Form-8949 row from a realized sale, applying term and wash-sale
 * logic. PURE.
 */
export function buildForm8949Row(sale: RealizedSaleInput, washSales: WashSaleResult[] = []): Form8949Row {
  const term = computeTerm(sale.dateAcquired, sale.dateSold);
  const rawGain = sale.proceeds - sale.costBasis;
  const adjustment = washAdjustmentFor(sale, rawGain, washSales);
  const basisReported = sale.basisReported === true;
  return {
    description: `${formatShares(sale.shares)} ${sale.ticker}`,
    ticker: sale.ticker,
    accountGuid: sale.accountGuid,
    shares: sale.shares,
    dateAcquired: sale.dateAcquired,
    dateSold: sale.dateSold,
    proceeds: sale.proceeds,
    costBasis: sale.costBasis,
    code: adjustment > 0 ? 'W' : '',
    adjustment,
    gain: rawGain + adjustment,
    term,
    basisReported,
    box: boxFor(term, basisReported),
  };
}

/**
 * Build the full capital-gains report (rows + buckets + Schedule D) from a set
 * of realized sales and detected wash sales. PURE.
 */
export function buildCapitalGainsReport(
  sales: RealizedSaleInput[],
  washSales: WashSaleResult[],
  year: number,
): CapitalGainsReport {
  const rows = sales.map(s => buildForm8949Row(s, washSales));
  const saleGuids = new Set(sales.map(sale => sale.splitGuid));
  const unmatchedWashWarnings = washSales
    .filter(washSale => !saleGuids.has(washSale.splitGuid))
    .map(washSale =>
      `Wash-sale adjustment for ${washSale.ticker} ($${Math.abs(washSale.loss).toFixed(2)}) ` +
      'was not applied because its disposal split is not reported on Form 8949; review this transaction.',
    );

  const buckets: Form8949Bucket[] = BUCKET_ORDER.map(def => ({
    ...def,
    rows: [],
    totals: emptyTotals(),
  }));
  const bucketByBox = new Map(buckets.map(b => [b.box, b]));

  for (const row of rows) {
    const bucket = bucketByBox.get(row.box)!;
    bucket.rows.push(row);
    addToTotals(bucket.totals, row);
  }

  const shortTerm = emptyTotals();
  const longTerm = emptyTotals();
  for (const row of rows) {
    addToTotals(row.term === 'short_term' ? shortTerm : longTerm, row);
  }

  const scheduleD: ScheduleDSummary = {
    shortTerm,
    longTerm,
    netShortTerm: shortTerm.gain,
    netLongTerm: longTerm.gain,
    net: shortTerm.gain + longTerm.gain,
  };

  const warnings = [...unmatchedWashWarnings, ...flagSuspectRows(rows)];

  return { year, rows, buckets, scheduleD, warnings };
}

// -----------------------------------------------------------------------------
// 1099-B reconciliation (pure)
// -----------------------------------------------------------------------------

export interface BrokerRow {
  ticker: string;
  dateSold: string;   // any parseable date; matched at day granularity
  proceeds: number;
  basis: number;
}

export interface ReconMatch {
  ticker: string;
  dateSold: string;
  shares: number;
  computedProceeds: number;
  brokerProceeds: number;
  computedBasis: number;
  brokerBasis: number;
  basisDelta: number;       // computed - broker
  basisMismatch: boolean;   // |delta| >= half a cent (MONEY_DISPLAY_EPSILON)
}

export interface ReconResult {
  matched: ReconMatch[];
  missingInBooks: BrokerRow[];        // on the 1099-B, no computed sale
  missingInBroker: RealizedSaleInput[]; // computed, not on the 1099-B
  summary: {
    matchedCount: number;
    mismatchCount: number;
    missingInBooksCount: number;
    missingInBrokerCount: number;
  };
}

/**
 * Reconcile computed sales against broker 1099-B rows. A row matches a sale
 * when ticker + sale day agree and proceeds are within `tolerance` (a whole
 * cent by default: brokers round intermediate commissions differently, so this
 * is a matching window, not an equality test).
 *
 * Basis is flagged (not used for matching) when it differs by half a cent or
 * more. It used to need MORE than a whole cent, which let a genuine one-cent
 * basis disagreement — the exact discrepancy this reconciliation exists to
 * surface before it reaches a Form 8949 — pass as agreement. PURE.
 */
export function reconcile1099B(
  sales: RealizedSaleInput[],
  brokerRows: BrokerRow[],
  tolerance = BROKER_PROCEEDS_MATCH_TOLERANCE,
): ReconResult {
  const usedSale = new Array(sales.length).fill(false);
  const matched: ReconMatch[] = [];
  const missingInBooks: BrokerRow[] = [];

  for (const broker of brokerRows) {
    const brokerDay = toDay(broker.dateSold);
    const idx = sales.findIndex(
      (s, i) =>
        !usedSale[i] &&
        s.ticker === broker.ticker &&
        toDay(s.dateSold) === brokerDay &&
        Math.abs(s.proceeds - broker.proceeds) <= tolerance,
    );
    if (idx === -1) {
      missingInBooks.push(broker);
      continue;
    }
    usedSale[idx] = true;
    const sale = sales[idx];
    const basisDelta = sale.costBasis - broker.basis;
    matched.push({
      ticker: sale.ticker,
      dateSold: sale.dateSold,
      shares: sale.shares,
      computedProceeds: sale.proceeds,
      brokerProceeds: broker.proceeds,
      computedBasis: sale.costBasis,
      brokerBasis: broker.basis,
      basisDelta,
      basisMismatch: Math.abs(basisDelta) >= MONEY_DISPLAY_EPSILON,
    });
  }

  const missingInBroker = sales.filter((_, i) => !usedSale[i]);

  return {
    matched,
    missingInBooks,
    missingInBroker,
    summary: {
      matchedCount: matched.length,
      mismatchCount: matched.filter(m => m.basisMismatch).length,
      missingInBooksCount: missingInBooks.length,
      missingInBrokerCount: missingInBroker.length,
    },
  };
}

/**
 * Parse a pasted broker CSV (ticker,dateSold,proceeds,basis) into BrokerRow[].
 * Tolerant of a header line, blank lines, $ and thousands separators. PURE.
 */
export function parseBrokerCSV(text: string): BrokerRow[] {
  const rows: BrokerRow[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(',').map(c => c.trim());
    if (cols.length < 4) continue;
    const [ticker, dateSold, proceedsRaw, basisRaw] = cols;
    // Skip a header row (non-numeric proceeds).
    const proceeds = parseFloat(proceedsRaw.replace(/[$,]/g, ''));
    const basis = parseFloat(basisRaw.replace(/[$,]/g, ''));
    if (!ticker || !dateSold || !Number.isFinite(proceeds) || !Number.isFinite(basis)) continue;
    rows.push({ ticker, dateSold, proceeds, basis });
  }
  return rows;
}

// -----------------------------------------------------------------------------
// CSV export (pure)
// -----------------------------------------------------------------------------

/** Form 8949 CSV in IRS column order, with a leading Box column. */
export function generateForm8949CSV(report: CapitalGainsReport): string {
  const rows: string[] = [
    'Box,Description of property (a),Date acquired (b),Date sold (c),Proceeds (d),Cost basis (e),Code (f),Adjustment (g),Gain or loss (h)',
  ];
  for (const bucket of report.buckets) {
    if (bucket.rows.length === 0) continue;
    for (const r of bucket.rows) {
      rows.push([
        bucket.box,
        escapeCSVField(r.description),
        toDay(r.dateAcquired),
        toDay(r.dateSold),
        r.proceeds.toFixed(2),
        r.costBasis.toFixed(2),
        r.code,
        r.adjustment ? r.adjustment.toFixed(2) : '',
        r.gain.toFixed(2),
      ].join(','));
    }
    rows.push([
      `${bucket.box} TOTALS`, '', '', '',
      bucket.totals.proceeds.toFixed(2),
      bucket.totals.costBasis.toFixed(2),
      '',
      bucket.totals.adjustments.toFixed(2),
      bucket.totals.gain.toFixed(2),
    ].join(','));
    rows.push('');
  }
  return rows.join('\n');
}

/** Schedule D summary CSV. */
export function generateScheduleDCSV(report: CapitalGainsReport): string {
  const { scheduleD } = report;
  const line = (label: string, t: TermTotals) =>
    [escapeCSVField(label), t.proceeds.toFixed(2), t.costBasis.toFixed(2), t.adjustments.toFixed(2), t.gain.toFixed(2)].join(',');
  return [
    'Line,Proceeds,Cost basis,Adjustments,Gain or loss',
    line('Part I — Total short-term', scheduleD.shortTerm),
    line('Part II — Total long-term', scheduleD.longTerm),
    '',
    `Net short-term capital gain/loss,,,,${scheduleD.netShortTerm.toFixed(2)}`,
    `Net long-term capital gain/loss,,,,${scheduleD.netLongTerm.toFixed(2)}`,
    `Net capital gain/loss,,,,${scheduleD.net.toFixed(2)}`,
  ].join('\n');
}

// -----------------------------------------------------------------------------
// DB loading (impure)
// -----------------------------------------------------------------------------

/**
 * Load every realized sale (one row PER SELL SPLIT, from closed lots and the
 * realized portions of open lots) in the book's TAXABLE STOCK/MUTUAL accounts
 * whose sale date falls in `year` (UTC calendar year of the sale's post date).
 *
 * Tax-advantaged accounts are excluded — sales inside a 401k/IRA/HSA never
 * appear on Form 8949 — and so are accounts whose effective tax-estimator
 * mapping is 'exclude' (user-marked non-taxable). This loader is the SINGLE
 * extraction shared by the 8949 report and the tax estimator
 * (aggregateBookTaxData in src/lib/tax/book-income.ts), so the two surfaces
 * cannot drift on Schedule D numbers or on the exclusion rules.
 *
 * `sinks` collects the trade-fee allocator's two by-products, both optional:
 *  - `feeWarnings`: notices about charges deliberately NOT capitalized
 *    (unrecognized or ambiguous accounts, unattributable mixed tickets) and
 *    about tax mappings neutralized on a fee account. The 8949 report shows
 *    them; callers with nowhere to display them may omit the sink.
 *  - `capitalizedFeeSplitGuids`: the expense splits whose value reached
 *    basis. aggregateBookTaxData drops exactly these from its deduction
 *    category sums, so a capitalized dollar is never also deducted, and a
 *    dollar that was NOT capitalized is never withheld from a deduction.
 */
export interface RealizedSalesSinks {
  feeWarnings?: string[];
  capitalizedFeeSplitGuids?: string[];
}

export async function loadRealizedSales(
  bookAccountGuids: string[],
  year: number,
  sinks: RealizedSalesSinks = {},
): Promise<RealizedSaleInput[]> {
  // Imported lazily-ish at top would pull prisma into pure test imports; keep
  // the imports here local to the loader boundary.
  const prisma = (await import('@/lib/prisma')).default;
  const { getLotsForAccounts } = await import('@/lib/lots');
  const { getRetirementAccountGuids } = await import('@/lib/reports/contribution-classifier');
  const { expandMappingsToDescendants } = await import('@/lib/tax/book-income');
  const { isTaxCategory } = await import('@/lib/tax/types');

  const [investmentAccounts, retirementGuids, mappingRows, accountRows] = await Promise.all([
    prisma.accounts.findMany({
      where: {
        guid: { in: bookAccountGuids },
        account_type: { in: ['STOCK', 'MUTUAL'] },
      },
      select: {
        guid: true,
        commodity: { select: { mnemonic: true } },
      },
    }),
    getRetirementAccountGuids(bookAccountGuids),
    prisma.gnucash_web_tax_mappings.findMany({
      where: { account_guid: { in: bookAccountGuids } },
    }),
    prisma.accounts.findMany({
      where: { guid: { in: bookAccountGuids } },
      select: { guid: true, parent_guid: true },
    }),
  ]);

  // Effective 'exclude' mappings cover descendants too (same semantics as
  // the tax estimator).
  const directMappings = new Map<string, import('@/lib/tax/types').TaxCategory>();
  for (const row of mappingRows) {
    if (isTaxCategory(row.tax_category)) directMappings.set(row.account_guid, row.tax_category);
  }
  const effectiveMappings = expandMappingsToDescendants(directMappings, accountRows);

  const taxableAccounts = investmentAccounts.filter(account =>
    !retirementGuids.has(account.guid) && effectiveMappings.get(account.guid) !== 'exclude'
  );
  // RAW lots, deliberately: this path runs its own fee allocation below, with
  // the tax mappings, and netting them here first would apply the commissions
  // twice. Every other caller wants the netted default.
  const lotsByAccount = await getLotsForAccounts(
    taxableAccounts.map(account => account.guid),
    { includeTradeFees: false },
  );

  // Brokerage commissions live on sibling EXPENSE splits of the trade
  // transactions, which the lot engine never loads; recover them once for
  // every transaction touching these lots so basis and proceeds are net of
  // fees (see @/lib/trade-fees).
  //
  // A classified trade fee is capitalized unconditionally — it is a cost of
  // the security, never a deduction — and the splits it consumed are reported
  // back so the tax aggregation can drop exactly those from its deduction
  // sums. The effective tax mappings are passed only so a mapping that this
  // neutralizes gets reported. Account paths drive fee-vs-not-a-fee
  // classification: account_type alone would capitalize accrued bond interest
  // and margin interest as basis.
  const { loadTradeFees } = await import('@/lib/trade-fees');
  const { buildAccountPathMap } = await import('@/lib/reports/utils');
  const tradeTxGuids: string[] = [];
  for (const account of taxableAccounts) {
    for (const lot of lotsByAccount.get(account.guid) ?? []) {
      for (const split of lot.splits) tradeTxGuids.push(split.txGuid);
    }
  }
  const accountPaths = tradeTxGuids.length > 0
    ? await buildAccountPathMap(bookAccountGuids)
    : new Map<string, string>();
  const allocation = await loadTradeFees(tradeTxGuids, {
    effectiveTaxMappings: effectiveMappings,
    accountPaths,
  });
  const fees = allocation.fees;
  sinks.feeWarnings?.push(...allocation.warnings);
  sinks.capitalizedFeeSplitGuids?.push(...allocation.capitalizedFeeSplitGuids);

  const sales: RealizedSaleInput[] = [];
  for (const account of taxableAccounts) {
    const ticker = account.commodity?.mnemonic || 'Unknown';
    const lots = lotsByAccount.get(account.guid) ?? [];
    for (const lot of lots) {
      for (const sale of lotToRealizedSales(lot, ticker, fees)) {
        if (new Date(sale.dateSold).getUTCFullYear() !== year) continue;
        sales.push(sale);
      }
    }
  }

  // Stable ordering: by sale date, then ticker.
  sales.sort((a, b) =>
    a.dateSold === b.dateSold ? a.ticker.localeCompare(b.ticker) : a.dateSold.localeCompare(b.dateSold),
  );
  return sales;
}

/**
 * Full capital-gains report for a book + year: loads realized sales, detects
 * wash sales, and builds the 8949 buckets + Schedule D summary.
 */
export async function loadCapitalGainsReport(
  bookAccountGuids: string[],
  year: number,
): Promise<CapitalGainsReport & { generatedAt: string }> {
  const { detectWashSales } = await import('@/lib/lot-assignment');
  const feeWarnings: string[] = [];
  const [sales, washSales] = await Promise.all([
    loadRealizedSales(bookAccountGuids, year, { feeWarnings }),
    detectWashSales(bookAccountGuids),
  ]);
  const report = buildCapitalGainsReport(sales, washSales, year);
  // Fees the allocator refused to capitalize belong in front of the user
  // BEFORE they file, not buried in a log.
  report.warnings.push(...feeWarnings);
  return { ...report, generatedAt: new Date().toISOString() };
}
