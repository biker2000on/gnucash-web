/**
 * Tax-Optimal Sell Planner
 *
 * "I need to raise $X — which lots do I sell, and what will it cost in tax?"
 *
 * PURE CORE (planSell / buildSellPlans) — no DB, no clock (asOf injected) —
 * plus server-only DB loaders at the bottom (lazy prisma imports, mirroring
 * the src/lib/rebalancing.ts pattern).
 *
 * ── Selection algorithm (strategy 'recommended') ─────────────────────────
 *  1. HARVEST LOSSES FIRST. Loss lots raise cash while REDUCING the tax
 *     bill. Short-term losses are consumed before long-term losses (ST
 *     losses first offset ST gains, which are taxed at ordinary rates, so
 *     they are the most valuable). Within each group, lots are ordered by
 *     loss-per-dollar-raised (most negative first) so each dollar of
 *     proceeds harvests the most loss.
 *     Loss lots whose sale would trigger a WASH SALE — the same security
 *     was bought within the look-back window (30 days) in ANY account,
 *     including IRAs (Rev. Rul. 2008-5) — are SKIPPED and reported
 *     separately. Future buys are unknowable; the caller is warned not to
 *     repurchase within 30 days after the sale.
 *  2. LONG-TERM GAINS next, in ascending gain-per-dollar-raised order:
 *     each dollar of proceeds realizes the least (preferentially-taxed)
 *     gain possible.
 *  3. SHORT-TERM GAINS last, also ascending gain-per-dollar. ST gains are
 *     taxed at ordinary rates and are consumed only when nothing cheaper
 *     remains. ST-gain lots within `almostLongTermDays` (default 45) of
 *     going long-term get a "waiting N days saves ~$Y" hint, computed by
 *     re-running the tax engine with that lot's gain reclassified ST→LT.
 *  4. Stop as soon as cumulative proceeds ≥ target. The final lot is sold
 *     PARTIALLY (pro-rata shares/basis/gain) so proceeds land exactly on
 *     the target.
 *
 * Comparison strategies:
 *  - 'fifo'           — naive oldest-acquired-first (what a broker default
 *                        does). Wash-sale losses are NOT skipped, only
 *                        flagged, since a naive seller wouldn't skip them.
 *  - 'long_term_only' — same ordering as recommended but restricted to
 *                        long-term lots; may fail to meet the target.
 *
 * ── Tax cost ─────────────────────────────────────────────────────────────
 * Incremental, not average: tax(baseline income + plan gains) − tax(baseline),
 * where baseline is the user's current-year FederalTaxInputs (YTD ordinary
 * income + realized ST/LT gains so far, from src/lib/tax/book-income.ts).
 * The existing federal engine handles ST/LT netting, the $3,000 loss cap,
 * LTCG bracket stacking, and NIIT; state tax comes from the state module at
 * the user's configured state (approximated on federal AGI, so ST and LT
 * are taxed alike at the state level). Effective rate = tax delta / proceeds.
 *
 * ESTIMATES ONLY — not tax advice.
 */

import { computeFederalTax, emptyFederalInputs } from '@/lib/tax/federal';
import { computeStateTax } from '@/lib/tax/state';
import { isLongTerm } from '@/lib/reports/capital-gains';
import { resolveContributionActuals } from '@/lib/tax/payments';
import type {
  BookTaxData,
  FederalTaxInputs,
  FilingStatus,
  StateTaxInputs,
  TaxCategory,
  TaxYear,
} from '@/lib/tax/types';

const EPS = 1e-9;
const MONEY_EPS = 0.005;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_ALMOST_LT_DAYS = 45;
/** IRS wash-sale window: substantially identical purchase within 30 days. */
export const WASH_SALE_WINDOW_DAYS = 30;

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type Term = 'short_term' | 'long_term';
export type SellStrategy = 'recommended' | 'fifo' | 'long_term_only';

/** An open lot (or remaining open portion) that could be sold. */
export interface SellLotCandidate {
  lotGuid: string;
  accountGuid: string;
  accountName: string;
  accountPath?: string;
  ticker: string;
  /** Remaining shares in the lot (> 0). */
  shares: number;
  /** Current price per share. */
  price: number;
  /** Cost basis of the remaining shares. */
  costBasis: number;
  /** ISO acquisition date (acquisition_date slot, else lot open date). */
  acquiredDate: string;
}

/** One (possibly partial) lot sale in a plan. */
export interface PlannedSale {
  lotGuid: string;
  ticker: string;
  accountGuid: string;
  accountName: string;
  accountPath?: string;
  /** Shares this plan sells from the lot. */
  sharesToSell: number;
  /** Total remaining shares in the lot. */
  lotShares: number;
  partial: boolean;
  acquiredDate: string;
  term: Term;
  proceeds: number;
  costBasis: number;
  /** Realized gain (negative = harvested loss). */
  gain: number;
  /** Days until this lot's NEXT share sale would be long-term (null if already LT). */
  daysUntilLongTerm: number | null;
  /** True for ST-gain lots within `almostLongTermDays` of going long-term. */
  almostLongTerm: boolean;
  /** Estimated tax saved by waiting until the lot goes long-term (almost-LT lots only). */
  waitSavesTax: number | null;
  /** Loss sale with a recent same-security buy — wash-sale exposure (fifo plan only). */
  washSaleRisk: boolean;
}

export interface SkippedWashSaleLot {
  lotGuid: string;
  ticker: string;
  accountGuid: string;
  accountName: string;
  /** Unrealized loss that selling would (partially) forfeit to the wash rule. */
  unrealizedLoss: number;
  /** Most recent same-security buy date inside the wash window. */
  lastBuyDate: string;
}

export interface SellPlanTax {
  federal: number;
  state: number;
  total: number;
  /** totalTax / totalProceeds (0 when no proceeds). */
  effectiveRateOnRaise: number;
}

export interface SellPlan {
  strategy: SellStrategy;
  label: string;
  targetCash: number;
  totalProceeds: number;
  targetMet: boolean;
  /** target - proceeds when the target could not be met (else 0). */
  shortfall: number;
  /** Net ST / LT realized gain in the plan (negative = net loss). */
  shortTermGain: number;
  longTermGain: number;
  netGain: number;
  totalCostBasis: number;
  /** Sum of negative-gain sales (a negative number). */
  harvestedLoss: number;
  tax: SellPlanTax;
  sales: PlannedSale[];
  /** Loss lots excluded for wash-sale exposure (recommended / long_term_only). */
  skippedWashSales: SkippedWashSaleLot[];
  warnings: string[];
}

/** Minimal federal result surface the planner needs — mockable in tests. */
export interface FederalTaxLike {
  totalTax: number;
  agi: number;
}

export interface StateTaxLike {
  tax: number;
}

/**
 * Current-year tax context. `baseline` already contains YTD ordinary income
 * and realized ST/LT gains; the planner only ADDS the plan's gains on top.
 * The compute functions default to the real engines and are injectable for
 * tests.
 */
export interface SellTaxContext {
  baseline: FederalTaxInputs;
  stateCode: string;
  stateFlatRate?: number;
  computeFederal?: (inputs: FederalTaxInputs) => FederalTaxLike;
  computeState?: (stateCode: string, inputs: StateTaxInputs) => StateTaxLike;
}

export interface SellPlanOptions {
  strategy?: SellStrategy;
  /** ISO date used for holding-period math. Defaults to today. */
  asOf?: string;
  /** ST-gain lots within this many days of long-term get a wait hint. Default 45. */
  almostLongTermDays?: number;
  /**
   * ticker → most recent buy date within the wash-sale look-back window.
   * Loss lots of these tickers are skipped (recommended / long_term_only)
   * or flagged (fifo).
   */
  recentBuysByTicker?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

export function marketValue(lot: SellLotCandidate): number {
  return lot.shares * lot.price;
}

export function unrealizedGain(lot: SellLotCandidate): number {
  return marketValue(lot) - lot.costBasis;
}

/** Gain realized per dollar of proceeds raised (negative for loss lots). */
export function gainPerDollar(lot: SellLotCandidate): number {
  const mv = marketValue(lot);
  return mv > EPS ? unrealizedGain(lot) / mv : 0;
}

export function termAsOf(lot: SellLotCandidate, asOf: string): Term {
  return isLongTerm(lot.acquiredDate, asOf) ? 'long_term' : 'short_term';
}

/**
 * Days from `asOf` until a sale of this lot becomes long-term (0 when it
 * already is). IRS long-term = sold STRICTLY after acquired + 1 year, so
 * the first long-term day is acquired + 1 year + 1 day.
 */
export function daysUntilLongTerm(lot: SellLotCandidate, asOf: string): number {
  const acquired = new Date(lot.acquiredDate);
  const firstLtDay = new Date(acquired);
  firstLtDay.setFullYear(firstLtDay.getFullYear() + 1);
  firstLtDay.setDate(firstLtDay.getDate() + 1);
  const days = Math.ceil((firstLtDay.getTime() - new Date(asOf).getTime()) / DAY_MS);
  return Math.max(0, days);
}

/**
 * Incremental federal + state tax of adding `addSt`/`addLt` capital gains
 * on top of the baseline: tax(baseline + gains) − tax(baseline).
 */
export function incrementalPlanTax(
  ctx: SellTaxContext,
  addSt: number,
  addLt: number,
): { federal: number; state: number; total: number } {
  const fed = ctx.computeFederal ?? computeFederalTax;
  const st = ctx.computeState ?? computeStateTax;

  const base = fed(ctx.baseline);
  const withPlan = fed({
    ...ctx.baseline,
    shortTermCapitalGains: ctx.baseline.shortTermCapitalGains + addSt,
    longTermCapitalGains: ctx.baseline.longTermCapitalGains + addLt,
  });

  const stateInputs = (agi: number): StateTaxInputs => ({
    year: ctx.baseline.year,
    filingStatus: ctx.baseline.filingStatus,
    federalAgi: agi,
    flatRateOverride: ctx.stateFlatRate,
  });
  const stateBase = st(ctx.stateCode, stateInputs(base.agi));
  const stateWithPlan = st(ctx.stateCode, stateInputs(withPlan.agi));

  const federal = round2(withPlan.totalTax - base.totalTax);
  const state = round2(stateWithPlan.tax - stateBase.tax);
  return { federal, state, total: round2(federal + state) };
}

/* ------------------------------------------------------------------ */
/* Ordering                                                            */
/* ------------------------------------------------------------------ */

/**
 * Tax-efficiency rank: 0 ST losses, 1 LT losses, 2 LT gains, 3 ST gains.
 * Within a rank, ascending gain-per-dollar (biggest loss / smallest gain
 * per dollar raised first).
 */
export function orderCandidates(
  candidates: SellLotCandidate[],
  asOf: string,
): SellLotCandidate[] {
  const rank = (lot: SellLotCandidate): number => {
    const loss = unrealizedGain(lot) < -MONEY_EPS;
    const lt = termAsOf(lot, asOf) === 'long_term';
    if (loss) return lt ? 1 : 0;
    return lt ? 2 : 3;
  };
  return [...candidates].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const g = gainPerDollar(a) - gainPerDollar(b);
    if (Math.abs(g) > EPS) return g;
    return a.lotGuid.localeCompare(b.lotGuid);
  });
}

function orderFifo(candidates: SellLotCandidate[]): SellLotCandidate[] {
  return [...candidates].sort(
    (a, b) => a.acquiredDate.localeCompare(b.acquiredDate) || a.lotGuid.localeCompare(b.lotGuid),
  );
}

function isWashExposed(
  lot: SellLotCandidate,
  recentBuysByTicker: Record<string, string>,
): boolean {
  return unrealizedGain(lot) < -MONEY_EPS && recentBuysByTicker[lot.ticker] !== undefined;
}

/* ------------------------------------------------------------------ */
/* Core planner                                                        */
/* ------------------------------------------------------------------ */

const STRATEGY_LABELS: Record<SellStrategy, string> = {
  recommended: 'Recommended (tax-optimal)',
  fifo: 'Naive FIFO (oldest first)',
  long_term_only: 'Long-term lots only',
};

/**
 * Plan which lots to sell to raise `targetCash`. Pure — inject `asOf` and
 * (in tests) the tax compute functions via the context.
 */
export function planSell(
  candidates: SellLotCandidate[],
  targetCash: number,
  taxContext: SellTaxContext,
  options: SellPlanOptions = {},
): SellPlan {
  const strategy: SellStrategy = options.strategy ?? 'recommended';
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);
  const almostDays = options.almostLongTermDays ?? DEFAULT_ALMOST_LT_DAYS;
  const recentBuys = options.recentBuysByTicker ?? {};
  const target = Math.max(0, targetCash);
  const warnings: string[] = [];

  // Sanitize: sellable lots only.
  const sellable = candidates.filter(
    c => c.shares > EPS && c.price > EPS && marketValue(c) > MONEY_EPS,
  );

  /* --- Strategy-specific candidate set + ordering --- */
  const skippedWashSales: SkippedWashSaleLot[] = [];
  let pool = sellable;

  if (strategy === 'long_term_only') {
    pool = pool.filter(c => termAsOf(c, asOf) === 'long_term');
  }

  if (strategy !== 'fifo') {
    // Skip wash-exposed loss lots; a tax-aware plan should not sell them.
    const kept: SellLotCandidate[] = [];
    for (const lot of pool) {
      if (isWashExposed(lot, recentBuys)) {
        skippedWashSales.push({
          lotGuid: lot.lotGuid,
          ticker: lot.ticker,
          accountGuid: lot.accountGuid,
          accountName: lot.accountName,
          unrealizedLoss: round2(unrealizedGain(lot)),
          lastBuyDate: recentBuys[lot.ticker],
        });
      } else {
        kept.push(lot);
      }
    }
    pool = kept;
  }

  const ordered = strategy === 'fifo' ? orderFifo(pool) : orderCandidates(pool, asOf);

  /* --- Consume lots until proceeds >= target (partial final lot) --- */
  const sales: PlannedSale[] = [];
  let remaining = target;
  for (const lot of ordered) {
    if (remaining <= MONEY_EPS) break;
    const mv = marketValue(lot);
    const full = mv <= remaining + MONEY_EPS;
    const proceeds = full ? mv : remaining;
    const fraction = full ? 1 : proceeds / mv;
    const gain = unrealizedGain(lot) * fraction;
    const term = termAsOf(lot, asOf);
    const dtl = term === 'long_term' ? null : daysUntilLongTerm(lot, asOf);
    const almostLongTerm =
      term === 'short_term' && gain > MONEY_EPS && dtl !== null && dtl <= almostDays;

    sales.push({
      lotGuid: lot.lotGuid,
      ticker: lot.ticker,
      accountGuid: lot.accountGuid,
      accountName: lot.accountName,
      accountPath: lot.accountPath,
      sharesToSell: round6(lot.shares * fraction),
      lotShares: round6(lot.shares),
      partial: !full,
      acquiredDate: lot.acquiredDate,
      term,
      proceeds: round2(proceeds),
      costBasis: round2(lot.costBasis * fraction),
      gain: round2(gain),
      daysUntilLongTerm: dtl,
      almostLongTerm,
      waitSavesTax: null, // filled below once plan totals are known
      washSaleRisk: strategy === 'fifo' && isWashExposed(lot, recentBuys),
    });
    remaining -= proceeds;
  }

  const totalProceeds = round2(sales.reduce((s, x) => s + x.proceeds, 0));
  const targetMet = target - totalProceeds <= MONEY_EPS;
  const shortfall = targetMet ? 0 : round2(target - totalProceeds);

  const shortTermGain = round2(
    sales.filter(s => s.term === 'short_term').reduce((s, x) => s + x.gain, 0),
  );
  const longTermGain = round2(
    sales.filter(s => s.term === 'long_term').reduce((s, x) => s + x.gain, 0),
  );
  const harvestedLoss = round2(
    sales.filter(s => s.gain < 0).reduce((s, x) => s + x.gain, 0),
  );
  const totalCostBasis = round2(sales.reduce((s, x) => s + x.costBasis, 0));

  /* --- Incremental tax of the plan --- */
  const planTax = incrementalPlanTax(taxContext, shortTermGain, longTermGain);

  /* --- Almost-long-term "wait N days" hints --- */
  for (const sale of sales) {
    if (!sale.almostLongTerm) continue;
    // Re-run the engine with this sale's gain reclassified ST → LT.
    const alt = incrementalPlanTax(
      taxContext,
      shortTermGain - sale.gain,
      longTermGain + sale.gain,
    );
    const saved = round2(planTax.total - alt.total);
    sale.waitSavesTax = saved > MONEY_EPS ? saved : 0;
  }

  /* --- Warnings --- */
  if (!targetMet) {
    warnings.push(
      strategy === 'long_term_only'
        ? `Long-term lots alone cannot raise the full target — $${shortfall.toLocaleString('en-US')} short.`
        : `Available lots cannot raise the full target — $${shortfall.toLocaleString('en-US')} short.`,
    );
  }
  if (skippedWashSales.length > 0) {
    warnings.push(
      `${skippedWashSales.length} loss lot${skippedWashSales.length > 1 ? 's' : ''} skipped: a recent purchase of the same security would trigger the wash-sale rule (loss disallowed).`,
    );
  }
  if (sales.some(s => s.washSaleRisk)) {
    warnings.push(
      'This plan sells loss lots with a recent same-security purchase — those losses would be disallowed as wash sales (tax shown assumes they are allowed).',
    );
  }
  const hinted = sales.filter(s => s.almostLongTerm && (s.waitSavesTax ?? 0) > 0);
  if (hinted.length > 0) {
    const totalSaved = round2(hinted.reduce((s, x) => s + (x.waitSavesTax ?? 0), 0));
    const maxDays = Math.max(...hinted.map(s => s.daysUntilLongTerm ?? 0));
    warnings.push(
      `${hinted.length} short-term lot${hinted.length > 1 ? 's' : ''} go${hinted.length > 1 ? '' : 'es'} long-term within ${maxDays} days — waiting would save ~$${totalSaved.toLocaleString('en-US')}.`,
    );
  }

  return {
    strategy,
    label: STRATEGY_LABELS[strategy],
    targetCash: round2(target),
    totalProceeds,
    targetMet,
    shortfall,
    shortTermGain,
    longTermGain,
    netGain: round2(shortTermGain + longTermGain),
    totalCostBasis,
    harvestedLoss,
    tax: {
      federal: planTax.federal,
      state: planTax.state,
      total: planTax.total,
      effectiveRateOnRaise:
        totalProceeds > EPS ? Math.round((planTax.total / totalProceeds) * 10000) / 10000 : 0,
    },
    sales,
    skippedWashSales,
    warnings,
  };
}

export interface SellPlanComparison {
  recommended: SellPlan;
  fifo: SellPlan;
  longTermOnly: SellPlan;
}

/** Build the recommended plan plus the two comparison plans. */
export function buildSellPlans(
  candidates: SellLotCandidate[],
  targetCash: number,
  taxContext: SellTaxContext,
  options: Omit<SellPlanOptions, 'strategy'> = {},
): SellPlanComparison {
  return {
    recommended: planSell(candidates, targetCash, taxContext, { ...options, strategy: 'recommended' }),
    fifo: planSell(candidates, targetCash, taxContext, { ...options, strategy: 'fifo' }),
    longTermOnly: planSell(candidates, targetCash, taxContext, { ...options, strategy: 'long_term_only' }),
  };
}

/* ------------------------------------------------------------------ */
/* Baseline inputs from book data (pure)                               */
/* ------------------------------------------------------------------ */

/** Categories annualizable from YTD (mirrors the tax-estimator page). */
const ANNUALIZABLE: TaxCategory[] = [
  'w2_wages', 'interest_income', 'tax_exempt_interest', 'ordinary_dividends',
  'qualified_dividends', 'self_employment_income', 'business_expense',
  'rental_income', 'retirement_income', 'social_security_benefits',
  'charitable_donation', 'mortgage_interest', 'property_tax',
  'state_local_tax_paid', 'state_withholding', 'state_estimated_tax_payment',
  'medical_expense', 'other_income', 'other_deduction',
];

function categoryTotal(bookData: BookTaxData, category: TaxCategory): number {
  return bookData.categories.find(c => c.category === category)?.total ?? 0;
}

/**
 * Build baseline FederalTaxInputs from aggregated book data: YTD ordinary
 * income (annualized to a full-year estimate by default) plus realized
 * ST/LT gains so far (NOT annualized — realized gains are lumpy).
 */
export function buildBaselineInputs(
  bookData: BookTaxData,
  year: TaxYear,
  filingStatus: FilingStatus,
  annualize: boolean,
  filersAge65Plus: number = 0,
): FederalTaxInputs {
  const factor = annualize && bookData.elapsedYearFraction < 1
    ? 1 / bookData.elapsedYearFraction
    : 1;
  const get = (c: TaxCategory) =>
    categoryTotal(bookData, c) * (ANNUALIZABLE.includes(c) ? factor : 1);

  const qualifiedDividends = get('qualified_dividends');
  const { trad401k, tradIra, hsa, sepIra, simpleIra } = resolveContributionActuals(bookData);

  return {
    ...emptyFederalInputs(year, filingStatus),
    wages: get('w2_wages'),
    interest: get('interest_income'),
    taxExemptInterest: get('tax_exempt_interest'),
    ordinaryDividends: get('ordinary_dividends') + qualifiedDividends,
    qualifiedDividends,
    shortTermCapitalGains: bookData.realizedGains.shortTerm,
    longTermCapitalGains: bookData.realizedGains.longTerm,
    selfEmploymentIncome: get('self_employment_income') - get('business_expense'),
    rentalIncome: get('rental_income'),
    retirementIncome: get('retirement_income'),
    socialSecurityBenefits: get('social_security_benefits'),
    otherIncome: get('other_income'),
    traditional401kContributions: trad401k,
    traditionalIraContributions: tradIra,
    hsaContributions: hsa,
    sepIraContributions: sepIra,
    simpleIraContributions: simpleIra,
    charitableDonations: get('charitable_donation'),
    mortgageInterest: get('mortgage_interest'),
    stateLocalTaxesPaid:
      get('state_withholding') + get('state_estimated_tax_payment') +
      get('property_tax') + get('state_local_tax_paid'),
    medicalExpenses: get('medical_expense'),
    otherDeductions: get('other_deduction'),
    filersAge65Plus,
  };
}

/* ------------------------------------------------------------------ */
/* DB loaders (server-only; lazy prisma imports so the pure core stays */
/* importable in tests and client components)                          */
/* ------------------------------------------------------------------ */

export interface SellPlannerAccount {
  guid: string;
  name: string;
  path: string;
  ticker: string;
  marketValue: number;
  unrealizedGain: number;
  lotCount: number;
  isRetirement: boolean;
  hasPrice: boolean;
}

export interface SellPlannerBookData {
  /** Sellable open lots in TAXABLE (non-retirement) accounts in scope. */
  candidates: SellLotCandidate[];
  /** All STOCK/MUTUAL accounts in the book (taxable + retirement) for the scope picker. */
  accounts: SellPlannerAccount[];
  /** Retirement holdings — selling there has no capital-gains consequence. */
  retirement: {
    totalMarketValue: number;
    accountCount: number;
  };
  /** ticker → most recent buy date within the wash-sale look-back window. */
  recentBuysByTicker: Record<string, string>;
  /** Tickers whose lots were dropped for lack of a current price. */
  missingPriceTickers: string[];
}

/**
 * Load open-lot sell candidates for the book. Taxable = STOCK/MUTUAL
 * accounts NOT under a retirement-flagged subtree. `scopeAccountGuids`
 * (when given) restricts candidates to those accounts; the account list
 * and recent-buy sweep always cover the whole book (a buy in ANY account
 * — including an IRA — can wash a loss).
 */
export async function loadSellCandidates(
  bookAccountGuids: string[],
  scopeAccountGuids?: string[],
): Promise<SellPlannerBookData> {
  const prisma = (await import('@/lib/prisma')).default;
  const { getAccountLots } = await import('@/lib/lots');
  const { getRetirementAccountGuids } = await import('@/lib/reports/contribution-classifier');

  const investmentAccounts = await prisma.accounts.findMany({
    where: {
      guid: { in: bookAccountGuids },
      account_type: { in: ['STOCK', 'MUTUAL'] },
    },
    select: {
      guid: true,
      name: true,
      commodity: { select: { mnemonic: true } },
    },
  });

  const retirementGuids = await getRetirementAccountGuids(bookAccountGuids);

  /* --- Full paths from the account_hierarchy view --- */
  const guids = investmentAccounts.map(a => a.guid);
  const pathMap = new Map<string, string>();
  if (guids.length > 0) {
    const pathRows = await prisma.$queryRaw<Array<{ guid: string; fullname: string }>>`
      SELECT guid, fullname FROM account_hierarchy WHERE guid = ANY(${guids})
    `;
    for (const row of pathRows) pathMap.set(row.guid, row.fullname);
  }

  const scope = scopeAccountGuids && scopeAccountGuids.length > 0
    ? new Set(scopeAccountGuids)
    : null;

  const candidates: SellLotCandidate[] = [];
  const accounts: SellPlannerAccount[] = [];
  const missingPrice = new Set<string>();
  let retirementValue = 0;
  let retirementCount = 0;

  for (const acct of investmentAccounts) {
    const ticker = acct.commodity?.mnemonic || 'Unknown';
    const isRetirement = retirementGuids.has(acct.guid);
    const lots = await getAccountLots(acct.guid);

    let acctValue = 0;
    let acctGain = 0;
    let lotCount = 0;
    let hasPrice = false;

    for (const lot of lots) {
      if (lot.isClosed || Math.abs(lot.totalShares) < 1e-4) continue;
      if (lot.currentPrice === null) {
        missingPrice.add(ticker);
        continue;
      }
      hasPrice = true;
      const mv = lot.currentPrice * lot.totalShares;
      if (mv <= MONEY_EPS) continue;
      lotCount += 1;
      acctValue += mv;
      acctGain += lot.unrealizedGain ?? 0;

      if (isRetirement) continue;
      if (scope && !scope.has(acct.guid)) continue;

      // Basis of the REMAINING shares (pro-rata over bought shares, as in
      // lots.ts unrealizedGain math).
      const boughtShares = lot.splits
        .filter(s => s.shares > 0)
        .reduce((sum, s) => sum + s.shares, 0);
      const remainingBasis = boughtShares > 1e-4
        ? lot.totalCost * (lot.totalShares / boughtShares)
        : lot.totalCost;

      candidates.push({
        lotGuid: lot.guid,
        accountGuid: acct.guid,
        accountName: acct.name,
        accountPath: pathMap.get(acct.guid),
        ticker,
        shares: lot.totalShares,
        price: lot.currentPrice,
        costBasis: round2(remainingBasis),
        acquiredDate: (lot.acquisitionDate || lot.openDate || '').slice(0, 10),
      });
    }

    if (lotCount > 0 || acctValue > MONEY_EPS) {
      accounts.push({
        guid: acct.guid,
        name: acct.name,
        path: pathMap.get(acct.guid) ?? acct.name,
        ticker,
        marketValue: round2(acctValue),
        unrealizedGain: round2(acctGain),
        lotCount,
        isRetirement,
        hasPrice,
      });
      if (isRetirement) {
        retirementValue += acctValue;
        retirementCount += 1;
      }
    }
  }

  accounts.sort((a, b) => b.marketValue - a.marketValue);

  /* --- Recent buys (wash-sale look-back) across ALL investment accounts --- */
  const recentBuysByTicker: Record<string, string> = {};
  if (guids.length > 0) {
    const cutoff = new Date(Date.now() - WASH_SALE_WINDOW_DAYS * DAY_MS);
    const buyRows = await prisma.$queryRaw<Array<{
      account_guid: string;
      last_buy: Date | null;
    }>>`
      SELECT s.account_guid, MAX(t.post_date) AS last_buy
      FROM splits s
      JOIN transactions t ON s.tx_guid = t.guid
      WHERE s.account_guid = ANY(${guids})
        AND s.quantity_num > 0
        AND t.post_date >= ${cutoff}
      GROUP BY s.account_guid
    `;
    const tickerByGuid = new Map(
      investmentAccounts.map(a => [a.guid, a.commodity?.mnemonic || 'Unknown']),
    );
    for (const row of buyRows) {
      if (!row.last_buy) continue;
      const ticker = tickerByGuid.get(row.account_guid);
      if (!ticker) continue;
      const day = row.last_buy.toISOString().slice(0, 10);
      const existing = recentBuysByTicker[ticker];
      if (!existing || day > existing) recentBuysByTicker[ticker] = day;
    }
  }

  return {
    candidates,
    accounts,
    retirement: {
      totalMarketValue: round2(retirementValue),
      accountCount: retirementCount,
    },
    recentBuysByTicker,
    missingPriceTickers: [...missingPrice].sort(),
  };
}

export interface SellTaxContextMeta {
  year: TaxYear;
  filingStatus: FilingStatus;
  stateCode: string;
  stateFlatRate: number;
  annualized: boolean;
  ytdShortTermGains: number;
  ytdLongTermGains: number;
  baselineFederalTax: number;
  baselineStateTax: number;
  baselineAgi: number;
  marginalRate: number;
}

/**
 * Load the user's current-year tax context: filing status / state from
 * preferences (overridable), YTD ordinary income and realized ST/LT gains
 * aggregated from the book (src/lib/tax/book-income.ts).
 */
export async function loadSellTaxContext(
  bookAccountGuids: string[],
  userId: number,
  overrides: {
    filingStatus?: FilingStatus;
    stateCode?: string;
    stateFlatRate?: number;
    annualize?: boolean;
  } = {},
): Promise<{ context: SellTaxContext; meta: SellTaxContextMeta }> {
  const { getPreference } = await import('@/lib/user-preferences');
  const { aggregateBookTaxData } = await import('@/lib/tax/book-income');
  const { FILING_STATUSES, isSupportedTaxYear } = await import('@/lib/tax/types');
  const { calculateAge } = await import('@/lib/reports/irs-limits');

  const currentYear = new Date().getFullYear();
  const year: TaxYear = isSupportedTaxYear(currentYear) ? currentYear : 2026;

  const [birthday, filingStatusPref, statePref, flatRatePref] = await Promise.all([
    getPreference<string | null>(userId, 'birthday', null),
    getPreference<string>(userId, 'tax_filing_status', 'single'),
    getPreference<string>(userId, 'tax_state', 'OTHER'),
    getPreference<number>(userId, 'tax_state_flat_rate', 0),
  ]);

  const filingStatus: FilingStatus =
    overrides.filingStatus && (FILING_STATUSES as readonly string[]).includes(overrides.filingStatus)
      ? overrides.filingStatus
      : (FILING_STATUSES as readonly string[]).includes(filingStatusPref)
        ? (filingStatusPref as FilingStatus)
        : 'single';
  const stateCode = overrides.stateCode ?? (statePref || 'OTHER');
  const stateFlatRate = overrides.stateFlatRate ??
    (typeof flatRatePref === 'number' ? flatRatePref : 0);
  const annualize = overrides.annualize ?? true;

  const bookData = await aggregateBookTaxData(bookAccountGuids, year, birthday);

  const age = birthday ? calculateAge(birthday, new Date(`${year}-12-31`)) : null;
  const filersAge65Plus = age !== null && age >= 65 ? 1 : 0;

  const baseline = buildBaselineInputs(bookData, year, filingStatus, annualize, filersAge65Plus);
  const context: SellTaxContext = { baseline, stateCode, stateFlatRate };

  const fedBase = computeFederalTax(baseline);
  const stateBase = computeStateTax(stateCode, {
    year,
    filingStatus,
    federalAgi: fedBase.agi,
    flatRateOverride: stateFlatRate,
  });

  return {
    context,
    meta: {
      year,
      filingStatus,
      stateCode,
      stateFlatRate,
      annualized: annualize,
      ytdShortTermGains: bookData.realizedGains.shortTerm,
      ytdLongTermGains: bookData.realizedGains.longTerm,
      baselineFederalTax: fedBase.totalTax,
      baselineStateTax: stateBase.tax,
      baselineAgi: fedBase.agi,
      marginalRate: fedBase.marginalRate,
    },
  };
}
