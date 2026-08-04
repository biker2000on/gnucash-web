/**
 * MFJ vs MFS filing comparison — pure functions, no I/O.
 *
 * Splits a household's aggregated book data (BookTaxData) into two per-spouse
 * columns, runs the shared federal engine once as MFJ and twice as MFS (one
 * run per spouse), and reports the total-tax difference with per-line
 * divergences, honest caveats, and a breakeven sweep over one chosen variable.
 *
 * ALLOCATION MODEL
 * - Attributable amounts follow the account owner recorded in
 *   `gnucash_web_account_preferences.owner` ('self' | 'spouse'). This covers
 *   W-2 wage/withholding accounts (payslip posting targets per-employer
 *   accounts, so the account owner IS the payslip owner) and investment
 *   accounts linked to a household roster member.
 * - Everything unattributable ('joint' or no owner recorded) goes into an
 *   explicit allocation split: `residualSelfPct` for income/withholding
 *   categories and `deductionsSelfPct` for itemized-deduction categories.
 *   Both default to 50/50 and are user-adjustable (persisted in tool config).
 * - Under MFS the spouses must EITHER both itemize or both take the standard
 *   deduction (§63(c)(6)(A) zeroes the standard deduction of an MFS filer
 *   whose spouse itemizes). Both legal combinations are computed and the
 *   cheaper one is chosen.
 *
 * OUT OF SCOPE (documented, not modeled):
 * - COMMUNITY-PROPERTY STATES (AZ, CA, ID, LA, NV, NM, TX, WA, WI): separate
 *   returns there must generally split community income 50/50 regardless of
 *   who earned it, which invalidates the owner-attribution model used here.
 *   The comparison is only meaningful in common-law states.
 * - State income tax (federal-only comparison).
 * - EITC, education credits, and the student-loan interest deduction are not
 *   in the federal engine; their MFS unavailability is surfaced as caveats,
 *   not modeled dollar-for-dollar.
 * - The taxable-Social-Security worksheet's MFS base of $0 assumes the
 *   spouses lived together during the year (the engine's existing rule).
 *
 * SIMPLIFICATIONS
 * - Prior-year capital-loss carryover and OBBBA tip/overtime/car-loan
 *   amounts are unattributable inputs; they split by `residualSelfPct`.
 * - CTC qualifying children go to ONE spouse under MFS (`ctcClaimant`);
 *   children cannot be split fractionally on real returns either.
 * - The hypothetical single×2 baseline is a marriage-penalty/bonus lens
 *   only — married taxpayers cannot legally file single.
 *
 * ESTIMATES ONLY — not tax advice.
 */

import { computeFederalTax } from './federal';
import {
  applyHouseholdTaxDetails,
  buildFederalInputsFromBookData,
  type HouseholdTaxDetailsResult,
} from './estimator-inputs';
import type {
  BookTaxData,
  CategoryAggregate,
  FederalTaxInputs,
  FederalTaxResult,
  TaxCategory,
  TaxYear,
} from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Allocation config                                                   */
/* ------------------------------------------------------------------ */

export type SpouseSlot = 'self' | 'spouse';
export type AccountOwner = 'self' | 'spouse' | 'joint';

export interface FilingAllocationConfig {
  /** Percent (0-100) of unattributable income/withholding assigned to self. */
  residualSelfPct: number;
  /** Percent (0-100) of unattributable itemized deductions assigned to self. */
  deductionsSelfPct: number;
  /** Which spouse claims the CTC qualifying children on a separate return. */
  ctcClaimant: SpouseSlot;
}

export const DEFAULT_ALLOCATION: FilingAllocationConfig = {
  residualSelfPct: 50,
  deductionsSelfPct: 50,
  ctcClaimant: 'self',
};

/** Clamp arbitrary (possibly persisted) config into a valid allocation. */
export function normalizeAllocation(raw: unknown): FilingAllocationConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pct = (v: unknown, dflt: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : dflt;
  return {
    residualSelfPct: pct(c.residualSelfPct, DEFAULT_ALLOCATION.residualSelfPct),
    deductionsSelfPct: pct(c.deductionsSelfPct, DEFAULT_ALLOCATION.deductionsSelfPct),
    ctcClaimant: c.ctcClaimant === 'spouse' ? 'spouse' : 'self',
  };
}

/**
 * Itemized-deduction categories that split by `deductionsSelfPct` when
 * unattributable. Everything else (income, withholding, contributions)
 * splits by `residualSelfPct`.
 */
const DEDUCTION_CATEGORIES: ReadonlySet<TaxCategory> = new Set<TaxCategory>([
  'charitable_donation',
  'mortgage_interest',
  'property_tax',
  'state_local_tax_paid',
  'medical_expense',
  'education_expense',
  'other_deduction',
]);

/* ------------------------------------------------------------------ */
/* Book-data split                                                     */
/* ------------------------------------------------------------------ */

export interface CategoryAttribution {
  category: TaxCategory;
  /** Owner-attributed to self (before residual allocation). */
  attributedSelf: number;
  /** Owner-attributed to spouse (before residual allocation). */
  attributedSpouse: number;
  /** Joint/unowned amount split by the allocation percentage. */
  unattributed: number;
}

export interface BookDataSplit {
  self: BookTaxData;
  spouse: BookTaxData;
  /** Per-category attribution summary for the allocation UI. */
  attribution: CategoryAttribution[];
  /** Realized-gains attribution (same three buckets, ST+LT combined). */
  gainsAttribution: { attributedSelf: number; attributedSpouse: number; unattributed: number };
}

function ownerOf(
  guid: string,
  ownerByAccount: Record<string, AccountOwner>,
): AccountOwner {
  const o = ownerByAccount[guid];
  return o === 'self' || o === 'spouse' ? o : 'joint';
}

/**
 * Split aggregated book data into per-spouse copies.
 *
 * Per-account amounts follow the account owner; joint/unowned amounts split
 * by the allocation percentage for their category class. Retirement
 * contributions use the classifier's per-owner split
 * (`contributionsByTypeAndOwner`) directly — each side becomes that side's
 * 'self' so the shared input assembly reads it unchanged.
 */
export function splitBookTaxData(
  bookData: BookTaxData,
  ownerByAccount: Record<string, AccountOwner>,
  allocation: FilingAllocationConfig,
): BookDataSplit {
  const attribution: CategoryAttribution[] = [];
  const selfCategories: CategoryAggregate[] = [];
  const spouseCategories: CategoryAggregate[] = [];

  for (const agg of bookData.categories) {
    const pctSelf =
      (DEDUCTION_CATEGORIES.has(agg.category)
        ? allocation.deductionsSelfPct
        : allocation.residualSelfPct) / 100;
    let attributedSelf = 0;
    let attributedSpouse = 0;
    let unattributed = 0;
    const selfAccounts: CategoryAggregate['accounts'] = [];
    const spouseAccounts: CategoryAggregate['accounts'] = [];

    for (const acct of agg.accounts) {
      const owner = ownerOf(acct.accountGuid, ownerByAccount);
      if (owner === 'self') {
        attributedSelf += acct.amount;
        selfAccounts.push({ ...acct });
      } else if (owner === 'spouse') {
        attributedSpouse += acct.amount;
        spouseAccounts.push({ ...acct });
      } else {
        unattributed += acct.amount;
        const toSelf = round2(acct.amount * pctSelf);
        const toSpouse = round2(acct.amount - toSelf);
        if (toSelf !== 0) selfAccounts.push({ ...acct, amount: toSelf });
        if (toSpouse !== 0) spouseAccounts.push({ ...acct, amount: toSpouse });
      }
    }

    const selfTotal = round2(selfAccounts.reduce((s, a) => s + a.amount, 0));
    const spouseTotal = round2(spouseAccounts.reduce((s, a) => s + a.amount, 0));
    selfCategories.push({ category: agg.category, total: selfTotal, accounts: selfAccounts });
    spouseCategories.push({ category: agg.category, total: spouseTotal, accounts: spouseAccounts });
    attribution.push({
      category: agg.category,
      attributedSelf: round2(attributedSelf),
      attributedSpouse: round2(attributedSpouse),
      unattributed: round2(unattributed),
    });
  }

  /* --- Realized gains: per-account attribution --- */
  const gainsPctSelf = allocation.residualSelfPct / 100;
  const gains = { attributedSelf: 0, attributedSpouse: 0, unattributed: 0 };
  const selfGainAccounts: BookTaxData['realizedGains']['accounts'] = [];
  const spouseGainAccounts: BookTaxData['realizedGains']['accounts'] = [];
  for (const acct of bookData.realizedGains.accounts) {
    const owner = ownerOf(acct.accountGuid, ownerByAccount);
    const total = acct.shortTerm + acct.longTerm;
    if (owner === 'self') {
      gains.attributedSelf += total;
      selfGainAccounts.push({ ...acct });
    } else if (owner === 'spouse') {
      gains.attributedSpouse += total;
      spouseGainAccounts.push({ ...acct });
    } else {
      gains.unattributed += total;
      const stSelf = round2(acct.shortTerm * gainsPctSelf);
      const ltSelf = round2(acct.longTerm * gainsPctSelf);
      selfGainAccounts.push({ ...acct, shortTerm: stSelf, longTerm: ltSelf });
      spouseGainAccounts.push({
        ...acct,
        shortTerm: round2(acct.shortTerm - stSelf),
        longTerm: round2(acct.longTerm - ltSelf),
      });
    }
  }
  const sumGains = (rows: BookTaxData['realizedGains']['accounts']) => ({
    shortTerm: round2(rows.reduce((s, r) => s + r.shortTerm, 0)),
    longTerm: round2(rows.reduce((s, r) => s + r.longTerm, 0)),
  });

  /* --- Retirement contributions: classifier per-owner split --- */
  const byOwner = bookData.contributionsByTypeAndOwner ?? {};
  const sideContributions = (slot: SpouseSlot) => {
    const contributionsByType: Record<string, number> = {};
    const contributionsByTypeAndOwner: Record<string, { self: number; spouse: number }> = {};
    for (const [type, split] of Object.entries(byOwner)) {
      const amt = round2(split[slot] ?? 0);
      contributionsByType[type] = amt;
      contributionsByTypeAndOwner[type] = { self: amt, spouse: 0 };
    }
    // Types present only in the un-split totals (no owner info) follow the
    // residual split so nothing is silently dropped.
    for (const [type, total] of Object.entries(bookData.contributionsByType ?? {})) {
      if (type in contributionsByType) continue;
      const share = round2(total * (slot === 'self' ? gainsPctSelf : 1 - gainsPctSelf));
      contributionsByType[type] = share;
      contributionsByTypeAndOwner[type] = { self: share, spouse: 0 };
    }
    return { contributionsByType, contributionsByTypeAndOwner };
  };

  const mkSide = (
    slot: SpouseSlot,
    categories: CategoryAggregate[],
    gainAccounts: BookTaxData['realizedGains']['accounts'],
  ): BookTaxData => ({
    ...bookData,
    categories,
    realizedGains: {
      ...sumGains(gainAccounts),
      accounts: gainAccounts,
      excludedAccountCount: bookData.realizedGains.excludedAccountCount,
    },
    ...sideContributions(slot),
    flaggedRetirementTypes: bookData.flaggedRetirementTypes,
  });

  return {
    self: mkSide('self', selfCategories, selfGainAccounts),
    spouse: mkSide('spouse', spouseCategories, spouseGainAccounts),
    attribution,
    gainsAttribution: {
      attributedSelf: round2(gains.attributedSelf),
      attributedSpouse: round2(gains.attributedSpouse),
      unattributed: round2(gains.unattributed),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Comparison parameters                                               */
/* ------------------------------------------------------------------ */

export interface SpouseTaxContext {
  /** This spouse is 65+ at year end. */
  age65: boolean;
  /** This spouse is an active participant in an employer plan. */
  coveredByEmployerPlan: boolean;
  /** This spouse's IRA contribution limit (base + catch-up), null unknown. */
  iraLimit: number | null;
}

export interface FilingComparisonParams {
  bookData: BookTaxData;
  ownerByAccount: Record<string, AccountOwner>;
  allocation: FilingAllocationConfig;
  year: TaxYear;
  /** The household's actual joint status — the comparison baseline. */
  jointFilingStatus: 'mfj' | 'qss';
  /** Annualization factor (>= 1) for YTD flows; 1 for complete years. */
  factor: number;
  /** CTC qualifying children (dependents under 17 at year end). */
  dependentsUnder17: number;
  self: SpouseTaxContext;
  spouse: SpouseTaxContext;
  /** Prior-year capital-loss carryover (positive), split by residual pct. */
  priorYearCapitalLossCarryover?: number;
  /** OBBBA user-entered amounts (household totals), split by residual pct. */
  qualifiedTipIncome?: number;
  qualifiedOvertimeCompensation?: number;
  qualifiedCarLoanInterest?: number;
  /** Also run the hypothetical single×2 marriage-penalty baseline. */
  includeSingleBaseline?: boolean;
}

/** Overrides used by the breakeven sweep. */
interface SweepOverrides {
  /** Replace the spouse column's annualized W-2 wages with this amount. */
  spouseWages?: number;
  /** Replace allocation.deductionsSelfPct. */
  deductionsSelfPct?: number;
  /** Additional LTCG realized (split by residual pct across spouses). */
  additionalLtcg?: number;
}

/* ------------------------------------------------------------------ */
/* Engine-run assembly                                                 */
/* ------------------------------------------------------------------ */

export interface MfsReturnRun {
  /** Result of the chosen deduction combination for this spouse. */
  result: FederalTaxResult;
  /** Phase-out details (IRA deductibility) from the household layer. */
  details: HouseholdTaxDetailsResult;
}

export interface MfsCombination {
  /** 'both_itemize' | 'both_standard' — the legal combination chosen. */
  chosen: 'both_itemize' | 'both_standard';
  /** Whether the both-standard combination was legal (neither itemized). */
  bothStandardLegal: boolean;
  bothItemizeTotal: number;
  bothStandardTotal: number | null;
  self: MfsReturnRun;
  spouse: MfsReturnRun;
  combinedTotalTax: number;
}

interface CoreRuns {
  mfj: { result: FederalTaxResult; details: HouseholdTaxDetailsResult };
  mfs: MfsCombination;
  single: { self: FederalTaxResult; spouse: FederalTaxResult } | null;
  split: BookDataSplit;
}

function applyDetails(
  base: FederalTaxInputs,
  ctx: {
    children: number;
    covered: boolean;
    otherCovered: boolean;
    iraLimit: number | null;
    spouseIraLimit: number | null;
    contributionsByTypeAndOwner?: Record<string, { self: number; spouse: number }>;
    tips: number;
    overtime: number;
    carLoan: number;
  },
): HouseholdTaxDetailsResult {
  return applyHouseholdTaxDetails(base, {
    qualifyingChildrenUnder17: ctx.children,
    coveredByEmployerPlan: ctx.covered,
    spouseCoveredByEmployerPlan: ctx.otherCovered,
    selfIraLimit: ctx.iraLimit,
    spouseIraLimit: ctx.spouseIraLimit,
    contributionsByTypeAndOwner: ctx.contributionsByTypeAndOwner,
    qualifiedTipIncome: ctx.tips,
    qualifiedOvertimeCompensation: ctx.overtime,
    qualifiedCarLoanInterest: ctx.carLoan,
  });
}

/** Force a return onto the standard deduction by removing itemizable inputs.
 * Charitable stays (it feeds the §170(p) non-itemizer deduction); the caller
 * verifies the engine did not itemize anyway (charitable > standard is rare).
 */
function withoutItemizables(inputs: FederalTaxInputs): FederalTaxInputs {
  return {
    ...inputs,
    stateLocalTaxesPaid: 0,
    mortgageInterest: 0,
    medicalExpenses: 0,
    otherDeductions: 0,
    mfsSpouseItemizes: false,
  };
}

/**
 * Run all engine passes for one configuration of the comparison.
 * Pure and deterministic; called once for the headline comparison and once
 * per point by the breakeven sweep.
 */
export function runComparisonAt(
  params: FilingComparisonParams,
  overrides: SweepOverrides = {},
): CoreRuns {
  const allocation: FilingAllocationConfig = {
    ...params.allocation,
    ...(overrides.deductionsSelfPct !== undefined
      ? { deductionsSelfPct: Math.min(100, Math.max(0, overrides.deductionsSelfPct)) }
      : {}),
  };
  const split = splitBookTaxData(params.bookData, params.ownerByAccount, allocation);
  const pctSelf = allocation.residualSelfPct / 100;

  const filers65Joint = (params.self.age65 ? 1 : 0) + (params.spouse.age65 ? 1 : 0);
  const carryover = Math.max(0, params.priorYearCapitalLossCarryover ?? 0);
  const tips = Math.max(0, params.qualifiedTipIncome ?? 0);
  const overtime = Math.max(0, params.qualifiedOvertimeCompensation ?? 0);
  const carLoan = Math.max(0, params.qualifiedCarLoanInterest ?? 0);

  /* --- Raw per-column inputs through the SHARED assembly --- */
  const mfjRaw = buildFederalInputsFromBookData(
    params.bookData, params.year, params.jointFilingStatus, filers65Joint, params.factor,
  );
  const selfRawBase = buildFederalInputsFromBookData(
    split.self, params.year, 'mfs', params.self.age65 ? 1 : 0, params.factor,
  );
  const spouseRawBase = buildFederalInputsFromBookData(
    split.spouse, params.year, 'mfs', params.spouse.age65 ? 1 : 0, params.factor,
  );

  /* --- Sweep overrides (post-annualization dollars) --- */
  const addLtcgSelf = round2((overrides.additionalLtcg ?? 0) * pctSelf);
  const addLtcgSpouse = round2((overrides.additionalLtcg ?? 0) - addLtcgSelf);
  const selfRaw: FederalTaxInputs = {
    ...selfRawBase,
    longTermCapitalGains: selfRawBase.longTermCapitalGains + addLtcgSelf,
    priorYearCapitalLossCarryover: round2(carryover * pctSelf),
  };
  const spouseRaw: FederalTaxInputs = {
    ...spouseRawBase,
    ...(overrides.spouseWages !== undefined
      ? { wages: Math.max(0, overrides.spouseWages) }
      : {}),
    longTermCapitalGains: spouseRawBase.longTermCapitalGains + addLtcgSpouse,
    priorYearCapitalLossCarryover: round2(carryover - round2(carryover * pctSelf)),
  };
  const mfjInputs: FederalTaxInputs = {
    ...mfjRaw,
    ...(overrides.spouseWages !== undefined
      ? { wages: round2(mfjRaw.wages - spouseRawBase.wages + Math.max(0, overrides.spouseWages)) }
      : {}),
    longTermCapitalGains: mfjRaw.longTermCapitalGains + (overrides.additionalLtcg ?? 0),
    priorYearCapitalLossCarryover: carryover,
  };

  /* --- MFJ run (household layer identical to the estimator) --- */
  const mfjDetails = applyDetails(mfjInputs, {
    children: params.dependentsUnder17,
    covered: params.self.coveredByEmployerPlan,
    otherCovered: params.spouse.coveredByEmployerPlan,
    iraLimit: params.self.iraLimit,
    spouseIraLimit: params.spouse.iraLimit,
    contributionsByTypeAndOwner: params.bookData.contributionsByTypeAndOwner,
    tips, overtime, carLoan,
  });
  const mfjResult = computeFederalTax(mfjDetails.inputs);

  /* --- MFS runs: both legal deduction combinations --- */
  const tipsSelf = round2(tips * pctSelf);
  const overtimeSelf = round2(overtime * pctSelf);
  const carLoanSelf = round2(carLoan * pctSelf);
  const mfsRun = (
    raw: FederalTaxInputs,
    slot: SpouseSlot,
    variant: 'itemize' | 'standard',
  ): MfsReturnRun => {
    const own = slot === 'self' ? params.self : params.spouse;
    const other = slot === 'self' ? params.spouse : params.self;
    const base = variant === 'itemize'
      ? { ...raw, mfsSpouseItemizes: true }
      : withoutItemizables(raw);
    const details = applyDetails(base, {
      children: allocation.ctcClaimant === slot ? params.dependentsUnder17 : 0,
      covered: own.coveredByEmployerPlan,
      otherCovered: other.coveredByEmployerPlan,
      iraLimit: own.iraLimit,
      spouseIraLimit: null,
      contributionsByTypeAndOwner:
        (slot === 'self' ? split.self : split.spouse).contributionsByTypeAndOwner,
      tips: slot === 'self' ? tipsSelf : round2(tips - tipsSelf),
      overtime: slot === 'self' ? overtimeSelf : round2(overtime - overtimeSelf),
      carLoan: slot === 'self' ? carLoanSelf : round2(carLoan - carLoanSelf),
    });
    return { details, result: computeFederalTax(details.inputs) };
  };

  const itemSelf = mfsRun(selfRaw, 'self', 'itemize');
  const itemSpouse = mfsRun(spouseRaw, 'spouse', 'itemize');
  const stdSelf = mfsRun(selfRaw, 'self', 'standard');
  const stdSpouse = mfsRun(spouseRaw, 'spouse', 'standard');

  const bothItemizeTotal = round2(itemSelf.result.totalTax + itemSpouse.result.totalTax);
  // "Both standard" is only legal when neither return itemizes (a spouse
  // whose charitable gifts alone beat the standard deduction still itemizes).
  const bothStandardLegal = !stdSelf.result.usedItemized && !stdSpouse.result.usedItemized;
  const bothStandardTotal = bothStandardLegal
    ? round2(stdSelf.result.totalTax + stdSpouse.result.totalTax)
    : null;

  const useStandard = bothStandardTotal !== null && bothStandardTotal < bothItemizeTotal;
  const mfs: MfsCombination = {
    chosen: useStandard ? 'both_standard' : 'both_itemize',
    bothStandardLegal,
    bothItemizeTotal,
    bothStandardTotal,
    self: useStandard ? stdSelf : itemSelf,
    spouse: useStandard ? stdSpouse : itemSpouse,
    combinedTotalTax: useStandard ? bothStandardTotal! : bothItemizeTotal,
  };

  /* --- Hypothetical single×2 baseline (marriage penalty/bonus lens) --- */
  let single: CoreRuns['single'] = null;
  if (params.includeSingleBaseline) {
    const singleRun = (raw: FederalTaxInputs, slot: SpouseSlot): FederalTaxResult => {
      const own = slot === 'self' ? params.self : params.spouse;
      const details = applyDetails({ ...raw, filingStatus: 'single', mfsSpouseItemizes: false }, {
        children: allocation.ctcClaimant === slot ? params.dependentsUnder17 : 0,
        covered: own.coveredByEmployerPlan,
        otherCovered: false,
        iraLimit: own.iraLimit,
        spouseIraLimit: null,
        contributionsByTypeAndOwner:
          (slot === 'self' ? split.self : split.spouse).contributionsByTypeAndOwner,
        tips: slot === 'self' ? tipsSelf : round2(tips - tipsSelf),
        overtime: slot === 'self' ? overtimeSelf : round2(overtime - overtimeSelf),
        carLoan: slot === 'self' ? carLoanSelf : round2(carLoan - carLoanSelf),
      });
      return computeFederalTax(details.inputs);
    };
    single = { self: singleRun(selfRaw, 'self'), spouse: singleRun(spouseRaw, 'spouse') };
  }

  return { mfj: { result: mfjResult, details: mfjDetails }, mfs, single, split };
}

/* ------------------------------------------------------------------ */
/* Divergences                                                         */
/* ------------------------------------------------------------------ */

export interface LineDivergence {
  key: string;
  label: string;
  mfj: number;
  /** Combined across both separate returns. */
  mfs: number;
  delta: number;
  /** Plain-English reason this line moves between the two filings. */
  explanation: string;
}

const DIVERGENCE_EXPLANATIONS: Record<string, string> = {
  deductionTaken:
    'MFS spouses must both itemize or both take the (half-sized) standard deduction; the split can strand deductions on the lower-income return.',
  seniorDeduction:
    'The OBBBA senior deduction (2025-2028) is not available on a separate return.',
  tipsDeduction:
    'The §224 tips deduction requires a joint return when married — MFS gets $0.',
  overtimeDeduction:
    'The §225 overtime deduction requires a joint return when married — MFS gets $0.',
  carLoanInterestDeduction:
    'The §163(h)(4) car-loan interest deduction is allowed for MFS but phases out from $100k MAGI per return instead of $200k joint.',
  credits:
    'Under MFS only one spouse claims each qualifying child, and the CTC phase-out threshold is $200k per return instead of $400k joint.',
  niit:
    'The NIIT MAGI threshold is $125k per MFS return vs $250k joint — investment income concentrated on one spouse crosses it sooner.',
  additionalMedicareTax:
    'The 0.9% Additional Medicare threshold is $125k per MFS return vs $250k joint.',
  capitalLossCarryoverToNextYear:
    'The capital-loss deduction cap is $1,500 per MFS return vs $3,000 joint — losses concentrated on one spouse defer to future years.',
  taxableSocialSecurity:
    'The taxable-Social-Security bases are $0 for MFS spouses who lived together, so more of the benefit is taxed.',
  qbiDeduction:
    'The §199A income limit is computed per return; splitting income changes each return’s cap.',
  ordinaryTax:
    'MFS brackets are half the joint widths; uneven income between spouses pushes the higher earner into higher brackets sooner.',
  capitalGainsTax:
    'The 0%/15%/20% LTCG breakpoints are roughly half the joint amounts per MFS return.',
  agi:
    'Per-spouse loss caps and phase-outs (capital-loss cap, IRA deductibility) change AGI when filing separately.',
};

export function buildDivergences(mfj: FederalTaxResult, mfs: MfsCombination): LineDivergence[] {
  const s = mfs.self.result;
  const p = mfs.spouse.result;
  const lines: Array<{ key: string; label: string; mfjV: number; mfsV: number }> = [
    { key: 'agi', label: 'Adjusted gross income', mfjV: mfj.agi, mfsV: round2(s.agi + p.agi) },
    { key: 'deductionTaken', label: 'Deduction taken', mfjV: mfj.deductionTaken, mfsV: round2(s.deductionTaken + p.deductionTaken) },
    { key: 'seniorDeduction', label: 'Senior deduction (OBBBA)', mfjV: mfj.seniorDeduction, mfsV: round2(s.seniorDeduction + p.seniorDeduction) },
    { key: 'tipsDeduction', label: 'Tips deduction (§224)', mfjV: mfj.tipsDeduction, mfsV: round2(s.tipsDeduction + p.tipsDeduction) },
    { key: 'overtimeDeduction', label: 'Overtime deduction (§225)', mfjV: mfj.overtimeDeduction, mfsV: round2(s.overtimeDeduction + p.overtimeDeduction) },
    { key: 'carLoanInterestDeduction', label: 'Car-loan interest deduction', mfjV: mfj.carLoanInterestDeduction, mfsV: round2(s.carLoanInterestDeduction + p.carLoanInterestDeduction) },
    { key: 'qbiDeduction', label: 'QBI deduction (§199A)', mfjV: mfj.qbiDeduction, mfsV: round2(s.qbiDeduction + p.qbiDeduction) },
    { key: 'taxableSocialSecurity', label: 'Taxable Social Security', mfjV: mfj.taxableSocialSecurity, mfsV: round2(s.taxableSocialSecurity + p.taxableSocialSecurity) },
    { key: 'ordinaryTax', label: 'Ordinary income tax', mfjV: mfj.ordinaryTax, mfsV: round2(s.ordinaryTax + p.ordinaryTax) },
    { key: 'capitalGainsTax', label: 'Capital gains tax', mfjV: mfj.capitalGainsTax, mfsV: round2(s.capitalGainsTax + p.capitalGainsTax) },
    { key: 'niit', label: 'Net Investment Income Tax', mfjV: mfj.niit, mfsV: round2(s.niit + p.niit) },
    { key: 'additionalMedicareTax', label: 'Additional Medicare tax', mfjV: mfj.additionalMedicareTax, mfsV: round2(s.additionalMedicareTax + p.additionalMedicareTax) },
    { key: 'credits', label: 'Child Tax Credit', mfjV: mfj.credits, mfsV: round2(s.credits + p.credits) },
    { key: 'capitalLossCarryoverToNextYear', label: 'Capital loss deferred to next year', mfjV: mfj.capitalLossCarryoverToNextYear, mfsV: round2(s.capitalLossCarryoverToNextYear + p.capitalLossCarryoverToNextYear) },
  ];
  const out: LineDivergence[] = [];
  for (const l of lines) {
    const delta = round2(l.mfsV - l.mfjV);
    if (Math.abs(delta) < 0.01) continue;
    out.push({
      key: l.key,
      label: l.label,
      mfj: round2(l.mfjV),
      mfs: round2(l.mfsV),
      delta,
      explanation: DIVERGENCE_EXPLANATIONS[l.key] ?? 'Differs between joint and separate computation.',
    });
  }
  out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return out;
}

/* ------------------------------------------------------------------ */
/* Caveats                                                             */
/* ------------------------------------------------------------------ */

export interface FilingCaveat {
  id: string;
  title: string;
  detail: string;
  /** True when the household's data suggests this caveat matters to them. */
  applies: boolean;
}

/**
 * EITC completed-phase-out AGI limits, MFJ, by number of qualifying children
 * (0/1/2/3+). Used ONLY to decide whether the "MFS forfeits the EITC" caveat
 * likely applies — the credit itself is not modeled.
 * 2024: Rev. Proc. 2023-34; 2025: Rev. Proc. 2024-40; 2026: Rev. Proc. 2025-32.
 */
const EITC_MFJ_AGI_LIMITS: Record<TaxYear, [number, number, number, number]> = {
  2024: [25_511, 56_004, 62_688, 66_819],
  2025: [26_214, 57_554, 64_430, 68_675],
  2026: [26_820, 58_863, 65_899, 70_224],
};

export function buildCaveats(
  params: FilingComparisonParams,
  runs: CoreRuns,
): FilingCaveat[] {
  const mfj = runs.mfj.result;
  const mfsSelf = runs.mfs.self;
  const mfsSpouse = runs.mfs.spouse;

  const earnedIncome =
    runs.mfj.details.inputs.wages + Math.max(0, runs.mfj.details.inputs.selfEmploymentIncome);
  const childBucket = Math.min(3, Math.max(0, params.dependentsUnder17));
  const eitcLimit = EITC_MFJ_AGI_LIMITS[params.year][childBucket];
  const eitcLikely = earnedIncome > 0 && mfj.agi > 0 && mfj.agi <= eitcLimit;

  const educationExpenses = params.bookData.categories
    .find(c => c.category === 'education_expense')?.total ?? 0;

  const mfsCarryover = round2(
    mfsSelf.result.capitalLossCarryoverToNextYear + mfsSpouse.result.capitalLossCarryoverToNextYear,
  );
  const lossCapBites = mfsCarryover > mfj.capitalLossCarryoverToNextYear + 0.005;

  const mfsNonDeductibleIra = round2(
    mfsSelf.details.phaseOuts.nonDeductibleIra + mfsSpouse.details.phaseOuts.nonDeductibleIra,
  );
  const iraBites = mfsNonDeductibleIra > runs.mfj.details.phaseOuts.nonDeductibleIra + 0.005;

  const itemizeForced =
    runs.mfs.chosen === 'both_itemize' &&
    (!mfsSelf.result.usedItemized || !mfsSpouse.result.usedItemized);

  const ssBenefits = runs.mfj.details.inputs.socialSecurityBenefits > 0;

  return [
    {
      id: 'eitc',
      title: 'MFS forfeits the Earned Income Tax Credit',
      detail: 'The EITC is not allowed on a separate return (narrow separated-spouse exception aside). This tool does not model the credit — if you qualify jointly, add its value to the MFJ side before deciding.',
      applies: eitcLikely,
    },
    {
      id: 'education',
      title: 'MFS forfeits education credits',
      detail: 'The American Opportunity and Lifetime Learning credits are not allowed on a separate return. Education expenses in your book suggest this could matter.',
      applies: educationExpenses > 0,
    },
    {
      id: 'student_loan',
      title: 'MFS forfeits the student-loan interest deduction',
      detail: 'The $2,500 student-loan interest deduction is not allowed on a separate return. Loan interest is not tracked in this comparison — check your 1098-E.',
      applies: false,
    },
    {
      id: 'idr',
      title: 'Income-driven student-loan plans often favor MFS anyway',
      detail: 'IDR plans (IBR, PAYE, ICR) compute payments from the borrower’s separate AGI when filing MFS — a common non-tax reason MFS wins overall. Not modeled here; compare projected loan payments separately.',
      applies: false,
    },
    {
      id: 'itemize_symmetry',
      title: 'Itemization must be symmetric under MFS',
      detail: itemizeForced
        ? 'One spouse itemizing zeroes the other’s standard deduction (§63(c)(6)) — in the chosen combination one return itemizes very little but the other must give up its standard deduction anyway.'
        : 'If one spouse itemizes, the other’s standard deduction is $0 (§63(c)(6)). Both legal combinations were computed and the cheaper one chosen.',
      applies: itemizeForced,
    },
    {
      id: 'loss_cap',
      title: 'Capital-loss cap is $1,500 per MFS return',
      detail: 'Each separate return can deduct at most $1,500 of net capital loss (vs $3,000 jointly); losses concentrated on one spouse defer to future years.',
      applies: lossCapBites,
    },
    {
      id: 'ira_deduction',
      title: 'Traditional-IRA deduction nearly vanishes under MFS',
      detail: 'The §219(g) phase-out for a covered MFS filer runs from $0 to $10,000 of MAGI, so contributions that are deductible jointly become non-deductible (Form 8606 basis) separately.',
      applies: iraBites,
    },
    {
      id: 'social_security',
      title: 'MFS taxes Social Security from the first dollar',
      detail: 'The taxable-benefit bases are $0 for separate filers who lived with their spouse during the year (this tool assumes you did).',
      applies: ssBenefits,
    },
    {
      id: 'community_property',
      title: 'Community-property states are out of scope',
      detail: 'In AZ, CA, ID, LA, NV, NM, TX, WA, and WI, separate returns generally must split community income 50/50 regardless of who earned it — this owner-based allocation does not apply there.',
      applies: false,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Headline comparison                                                 */
/* ------------------------------------------------------------------ */

export interface FilingComparisonResult {
  year: TaxYear;
  jointFilingStatus: 'mfj' | 'qss';
  allocation: FilingAllocationConfig;
  mfj: FederalTaxResult;
  mfsSelf: FederalTaxResult;
  mfsSpouse: FederalTaxResult;
  mfsCombinedTotalTax: number;
  mfsCombination: {
    chosen: 'both_itemize' | 'both_standard';
    bothItemizeTotal: number;
    bothStandardTotal: number | null;
  };
  /** mfsCombinedTotalTax − mfj.totalTax: positive means MFJ wins. */
  mfsMinusMfj: number;
  winner: 'mfj' | 'mfs' | 'tie';
  /** Combined non-deductible traditional IRA under each filing. */
  nonDeductibleIra: { mfj: number; mfs: number };
  divergences: LineDivergence[];
  caveats: FilingCaveat[];
  attribution: CategoryAttribution[];
  gainsAttribution: BookDataSplit['gainsAttribution'];
  /** Hypothetical two-single baseline (marriage penalty/bonus lens). */
  singleBaseline: {
    self: FederalTaxResult;
    spouse: FederalTaxResult;
    combinedTotalTax: number;
    /** mfj.totalTax − single combined: positive = marriage penalty. */
    marriagePenalty: number;
  } | null;
}

export function compareFilingStatuses(params: FilingComparisonParams): FilingComparisonResult {
  const runs = runComparisonAt(params);
  const mfsMinusMfj = round2(runs.mfs.combinedTotalTax - runs.mfj.result.totalTax);
  const singleCombined = runs.single
    ? round2(runs.single.self.totalTax + runs.single.spouse.totalTax)
    : null;
  return {
    year: params.year,
    jointFilingStatus: params.jointFilingStatus,
    allocation: params.allocation,
    mfj: runs.mfj.result,
    mfsSelf: runs.mfs.self.result,
    mfsSpouse: runs.mfs.spouse.result,
    mfsCombinedTotalTax: runs.mfs.combinedTotalTax,
    mfsCombination: {
      chosen: runs.mfs.chosen,
      bothItemizeTotal: runs.mfs.bothItemizeTotal,
      bothStandardTotal: runs.mfs.bothStandardTotal,
    },
    mfsMinusMfj,
    winner: Math.abs(mfsMinusMfj) < 0.01 ? 'tie' : mfsMinusMfj > 0 ? 'mfj' : 'mfs',
    nonDeductibleIra: {
      mfj: runs.mfj.details.phaseOuts.nonDeductibleIra,
      mfs: round2(
        runs.mfs.self.details.phaseOuts.nonDeductibleIra +
        runs.mfs.spouse.details.phaseOuts.nonDeductibleIra,
      ),
    },
    divergences: buildDivergences(runs.mfj.result, runs.mfs),
    caveats: buildCaveats(params, runs),
    attribution: runs.split.attribution,
    gainsAttribution: runs.split.gainsAttribution,
    singleBaseline: runs.single && singleCombined !== null
      ? {
          self: runs.single.self,
          spouse: runs.single.spouse,
          combinedTotalTax: singleCombined,
          marriagePenalty: round2(runs.mfj.result.totalTax - singleCombined),
        }
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* Breakeven sweep                                                     */
/* ------------------------------------------------------------------ */

export type SweepVariable = 'spouseWages' | 'deductionsSelfPct' | 'capitalGainRealization';

export const SWEEP_VARIABLE_LABELS: Record<SweepVariable, string> = {
  spouseWages: 'Spouse W-2 wages',
  deductionsSelfPct: 'Deduction allocation to self (%)',
  capitalGainRealization: 'Additional long-term gain realized',
};

export interface SweepPoint {
  x: number;
  mfjTotal: number;
  mfsTotal: number;
}

export interface BreakevenResult {
  variable: SweepVariable;
  points: SweepPoint[];
  /** The household's current position on the swept axis. */
  currentX: number;
  /** Interpolated x values where MFS−MFJ changes sign. */
  crossovers: number[];
  verdict: 'mfj_always' | 'mfs_always' | 'crossover' | 'tie';
}

/**
 * Find sign changes of (mfsTotal − mfjTotal) with linear interpolation.
 * Exported for direct testing.
 */
export function findCrossovers(points: SweepPoint[]): {
  crossovers: number[];
  verdict: BreakevenResult['verdict'];
} {
  const EPS = 0.005;
  const diffs = points.map(p => p.mfsTotal - p.mfjTotal);
  const crossovers: number[] = [];
  let sawPositive = false;
  let sawNegative = false;
  let prevSign = 0;
  for (let i = 0; i < points.length; i++) {
    const d = diffs[i];
    const sign = d > EPS ? 1 : d < -EPS ? -1 : 0;
    if (sign > 0) sawPositive = true;
    if (sign < 0) sawNegative = true;
    if (i > 0 && sign !== 0 && prevSign !== 0 && sign !== prevSign) {
      const x0 = points[i - 1].x;
      const x1 = points[i].x;
      const d0 = diffs[i - 1];
      const d1 = diffs[i];
      const t = d0 / (d0 - d1);
      crossovers.push(Math.round((x0 + t * (x1 - x0)) * 100) / 100);
    } else if (sign === 0 && prevSign !== 0) {
      crossovers.push(points[i].x);
    }
    if (sign !== 0) prevSign = sign;
  }
  if (crossovers.length > 0 && sawPositive && sawNegative) {
    return { crossovers, verdict: 'crossover' };
  }
  if (sawPositive && !sawNegative) return { crossovers: [], verdict: 'mfj_always' };
  if (sawNegative && !sawPositive) return { crossovers: [], verdict: 'mfs_always' };
  if (!sawPositive && !sawNegative) return { crossovers: [], verdict: 'tie' };
  // Touched zero without a true sign change — treat the touch points as ties.
  return { crossovers, verdict: 'crossover' };
}

/** Default sweep range for a variable given the current comparison inputs. */
export function defaultSweepRange(
  variable: SweepVariable,
  currentSpouseWages: number,
  currentLtcg: number,
): { min: number; max: number; steps: number } {
  switch (variable) {
    case 'spouseWages': {
      const max = Math.max(50_000, Math.ceil((currentSpouseWages * 2) / 10_000) * 10_000);
      return { min: 0, max, steps: 40 };
    }
    case 'deductionsSelfPct':
      return { min: 0, max: 100, steps: 20 };
    case 'capitalGainRealization': {
      const max = Math.max(100_000, Math.ceil((Math.max(0, currentLtcg) * 2) / 10_000) * 10_000);
      return { min: 0, max, steps: 40 };
    }
  }
}

export function runBreakevenSweep(
  params: FilingComparisonParams,
  variable: SweepVariable,
  range?: { min: number; max: number; steps: number },
): BreakevenResult {
  const baseline = runComparisonAt(params);
  // Current spouse wages in annualized engine dollars (matches the sweep axis).
  const currentSpouseWages = buildFederalInputsFromBookData(
    baseline.split.spouse, params.year, 'mfs', 0, params.factor,
  ).wages;
  const currentLtcg = params.bookData.realizedGains.longTerm; // point-in-time; not annualized
  const r = range ?? defaultSweepRange(variable, currentSpouseWages, currentLtcg);
  const steps = Math.max(2, Math.floor(r.steps));
  const currentX =
    variable === 'spouseWages' ? round2(currentSpouseWages)
    : variable === 'deductionsSelfPct' ? params.allocation.deductionsSelfPct
    : 0;

  const points: SweepPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = r.min + ((r.max - r.min) * i) / steps;
    const overrides: SweepOverrides =
      variable === 'spouseWages' ? { spouseWages: x }
      : variable === 'deductionsSelfPct' ? { deductionsSelfPct: x }
      : { additionalLtcg: x };
    const runs = runComparisonAt(params, overrides);
    points.push({
      x: round2(x),
      mfjTotal: runs.mfj.result.totalTax,
      mfsTotal: runs.mfs.combinedTotalTax,
    });
  }
  const { crossovers, verdict } = findCrossovers(points);
  return { variable, points, currentX, crossovers, verdict };
}
