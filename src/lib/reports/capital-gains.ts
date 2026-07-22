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
 *
 * The row-building math is PURE (no DB, no clock) so it can be unit-tested;
 * DB loading lives in the separate loadRealizedSales / loadCapitalGainsReport
 * functions at the bottom.
 */

import type { LotSummary } from '@/lib/lots';
import type { WashSaleResult } from '@/lib/lot-assignment';
import { escapeCSVField } from '@/lib/reports/csv-export';

const EPS = 0.0001;

export type Term = 'short_term' | 'long_term';
export type Form8949Box = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/** One realized disposal, before wash-sale / bucketing logic is applied. */
export interface RealizedSaleInput {
  accountGuid: string;
  ticker: string;
  shares: number;          // shares sold (positive)
  dateAcquired: string;    // ISO date
  dateSold: string;        // ISO date
  proceeds: number;
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

/**
 * IRS long-term = held MORE than one year. The holding period begins the day
 * after acquisition, so a sale is long-term only if it falls strictly after
 * the same calendar date one year later.
 */
export function isLongTerm(dateAcquired: string, dateSold: string): boolean {
  const acquired = new Date(dateAcquired);
  const sold = new Date(dateSold);
  const oneYearLater = new Date(acquired);
  oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
  return sold.getTime() > oneYearLater.getTime();
}

export function computeTerm(dateAcquired: string, dateSold: string): Term {
  return isLongTerm(dateAcquired, dateSold) ? 'long_term' : 'short_term';
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
 * Extract the realized sale from a closed (or partially-closed) lot. Returns
 * null when the lot has no sell splits (nothing realized yet). PURE given the
 * LotSummary — no DB access.
 *
 * Basis / proceeds use native GnuCash split signs: buys have positive value,
 * sells negative. For a fully-closed lot the basis is the total buy cost; for
 * a partial lot only the sold shares' pro-rata basis is realized.
 */
export function lotToRealizedSale(lot: LotSummary, ticker: string): RealizedSaleInput | null {
  const sells = lot.splits.filter(s => s.shares < -EPS);
  if (sells.length === 0) return null;

  const buys = lot.splits.filter(s => s.shares > EPS);
  const boughtShares = buys.reduce((sum, s) => sum + s.shares, 0);
  const buyCost = buys.reduce((sum, s) => sum + Math.abs(s.value), 0);
  const soldShares = sells.reduce((sum, s) => sum + Math.abs(s.shares), 0);
  const proceeds = -sells.reduce((sum, s) => sum + s.value, 0);
  const costPerShare = boughtShares > EPS ? buyCost / boughtShares : 0;
  const costBasis = lot.isClosed ? buyCost : soldShares * costPerShare;

  // dateSold = latest sell split; dateAcquired = acquisition slot -> open date
  const dateSold = sells.reduce(
    (latest, s) => (s.postDate > latest ? s.postDate : latest),
    sells[0].postDate,
  );
  const earliestBuy = buys.length > 0
    ? buys.reduce((earliest, s) => (s.postDate < earliest ? s.postDate : earliest), buys[0].postDate)
    : null;
  const dateAcquired = lot.acquisitionDate || lot.openDate || earliestBuy || dateSold;

  return {
    accountGuid: lot.accountGuid,
    ticker,
    shares: soldShares,
    dateAcquired,
    dateSold,
    proceeds,
    costBasis,
  };
}

/**
 * Find the wash-sale disallowed amount for a sale (>= 0), or 0 if none.
 * Matches on ticker + account + same sale day. WashSaleResult.loss is stored
 * negative; the disallowed adjustment is capped at the sale's actual loss so a
 * gain never flips positive.
 */
function washAdjustmentFor(
  sale: RealizedSaleInput,
  rawGain: number,
  washSales: WashSaleResult[],
): number {
  if (rawGain >= 0) return 0;
  const saleDay = toDay(sale.dateSold);
  const match = washSales.find(
    ws =>
      ws.ticker === sale.ticker &&
      ws.sellAccountGuid === sale.accountGuid &&
      toDay(ws.sellDate) === saleDay,
  );
  if (!match) return 0;
  const disallowed = Math.abs(match.loss);
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

  const warnings = flagSuspectRows(rows);

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
  basisMismatch: boolean;   // |delta| > 0.01
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
 * when ticker + sale day agree and proceeds are within `tolerance`. Basis is
 * flagged (not used for matching) when it differs by more than $0.01. PURE.
 */
export function reconcile1099B(
  sales: RealizedSaleInput[],
  brokerRows: BrokerRow[],
  tolerance = 0.01,
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
      basisMismatch: Math.abs(basisDelta) > 0.01,
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
 * Load every realized sale (closed lots + closed portions of partial lots) in
 * the book's TAXABLE STOCK/MUTUAL accounts whose sale date falls in `year`.
 *
 * Tax-advantaged accounts are excluded — sales inside a 401k/IRA/HSA never
 * appear on Form 8949 — and so are accounts whose effective tax-estimator
 * mapping is 'exclude' (user-marked non-taxable), matching the Schedule D
 * numbers produced by aggregateBookTaxData in src/lib/tax/book-income.ts.
 */
export async function loadRealizedSales(
  bookAccountGuids: string[],
  year: number,
): Promise<RealizedSaleInput[]> {
  // Imported lazily-ish at top would pull prisma into pure test imports; keep
  // the imports here local to the loader boundary.
  const prisma = (await import('@/lib/prisma')).default;
  const { getAccountLots } = await import('@/lib/lots');
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

  const sales: RealizedSaleInput[] = [];
  for (const account of investmentAccounts) {
    if (retirementGuids.has(account.guid)) continue;
    if (effectiveMappings.get(account.guid) === 'exclude') continue;
    const ticker = account.commodity?.mnemonic || 'Unknown';
    const lots = await getAccountLots(account.guid);
    for (const lot of lots) {
      const sale = lotToRealizedSale(lot, ticker);
      if (!sale) continue;
      if (new Date(sale.dateSold).getUTCFullYear() !== year) continue;
      sales.push(sale);
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
  const [sales, washSales] = await Promise.all([
    loadRealizedSales(bookAccountGuids, year),
    detectWashSales(bookAccountGuids),
  ]);
  const report = buildCapitalGainsReport(sales, washSales, year);
  return { ...report, generatedAt: new Date().toISOString() };
}
