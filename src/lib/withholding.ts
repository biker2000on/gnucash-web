/**
 * Withholding Checkup — mid-year year-end tax projection vs YTD withholding,
 * plus the safe-harbor quarterly 1040-ES picture.
 *
 * The heavy tax math is NOT reimplemented here: the projected year-end
 * liability comes from `computeFederalTax`, and the safe-harbor target /
 * quarterly schedule come from `computeSafeHarbor` (both in `@/lib/tax/federal`).
 * This module adds the annualization-from-YTD projection, the under/over
 * withholding classification, the remaining-quarterly picture, and the
 * recommended per-paycheck withholding bump.
 *
 * `computeWithholdingCheckup` is a pure function (unit-tested). The
 * `loadWithholdingCheckup` DB loader gathers the YTD figures from the book
 * (reusing the tax estimator's book aggregation + payment summing) and
 * corroborates withholding / pay cadence from payslips when available.
 *
 * ESTIMATES ONLY — not tax advice.
 */

import { computeFederalTax, computeSafeHarbor, emptyFederalInputs } from '@/lib/tax/federal';
import { resolveContributionActuals, summarizeTaxPayments } from '@/lib/tax/payments';
import { aggregateBookTaxData } from '@/lib/tax/book-income';
import {
  isSupportedTaxYear,
  type BookTaxData,
  type FederalTaxInputs,
  type FederalTaxResult,
  type FilingStatus,
  type QuarterlyPayment,
  type SafeHarborResult,
  type TaxCategory,
  type TaxYear,
} from '@/lib/tax/types';

const round2 = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Book → federal inputs (raw YTD, no annualization)                   */
/* ------------------------------------------------------------------ */

/**
 * FederalTaxInputs fields that are simple annual flows and can be scaled by
 * the annualization factor. Mirrors the tax estimator's ANNUALIZABLE list,
 * expressed at the engine-input level. Capital gains (point-in-time realized
 * lots) and retirement contributions are intentionally excluded — they are
 * never annualized.
 */
const ANNUALIZABLE_INPUT_FIELDS = [
  'wages',
  'interest',
  'taxExemptInterest',
  'ordinaryDividends',
  'qualifiedDividends',
  'selfEmploymentIncome',
  'rentalIncome',
  'retirementIncome',
  'socialSecurityBenefits',
  'otherIncome',
  'charitableDonations',
  'mortgageInterest',
  'stateLocalTaxesPaid',
  'medicalExpenses',
  'otherDeductions',
] as const satisfies readonly (keyof FederalTaxInputs)[];

function categoryTotal(bookData: BookTaxData, category: TaxCategory): number {
  return bookData.categories.find(c => c.category === category)?.total ?? 0;
}

/**
 * Map aggregated book data to raw YTD FederalTaxInputs (no annualization).
 * Mirrors the tax estimator page's `buildInputs` at factor = 1, reusing
 * `resolveContributionActuals` so flagged retirement contributions stay
 * authoritative. Annualization happens later inside the pure checkup.
 */
export function buildFederalInputsFromBook(
  bookData: BookTaxData,
  year: TaxYear,
  filingStatus: FilingStatus,
  filersAge65Plus = 0,
): FederalTaxInputs {
  const g = (c: TaxCategory) => categoryTotal(bookData, c);
  const qualifiedDividends = g('qualified_dividends');
  const { trad401k, tradIra, hsa, sepIra, simpleIra } = resolveContributionActuals(bookData);

  return {
    ...emptyFederalInputs(year, filingStatus),
    wages: g('w2_wages'),
    interest: g('interest_income'),
    taxExemptInterest: g('tax_exempt_interest'),
    ordinaryDividends: g('ordinary_dividends') + qualifiedDividends,
    qualifiedDividends,
    shortTermCapitalGains: bookData.realizedGains.shortTerm,
    longTermCapitalGains: bookData.realizedGains.longTerm,
    selfEmploymentIncome: g('self_employment_income') - g('business_expense'),
    rentalIncome: g('rental_income'),
    retirementIncome: g('retirement_income'),
    socialSecurityBenefits: g('social_security_benefits'),
    otherIncome: g('other_income'),
    traditional401kContributions: trad401k,
    traditionalIraContributions: tradIra,
    hsaContributions: hsa,
    sepIraContributions: sepIra,
    simpleIraContributions: simpleIra,
    charitableDonations: g('charitable_donation'),
    mortgageInterest: g('mortgage_interest'),
    // State estimated payments count as state income tax paid (Schedule A 5a),
    // same as state withholding — matches the estimator.
    stateLocalTaxesPaid:
      g('state_withholding') + g('state_estimated_tax_payment') + g('property_tax') + g('state_local_tax_paid'),
    medicalExpenses: g('medical_expense'),
    otherDeductions: g('other_deduction'),
    filersAge65Plus,
  };
}

/** Scale the annualizable flows of a YTD input set by `factor`. */
export function annualizeInputs(ytd: FederalTaxInputs, factor: number): FederalTaxInputs {
  if (!(factor > 1)) return { ...ytd };
  const out: FederalTaxInputs = { ...ytd };
  for (const field of ANNUALIZABLE_INPUT_FIELDS) {
    const v = out[field];
    if (typeof v === 'number') {
      (out[field] as number) = round2(v * factor);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Pure checkup                                                        */
/* ------------------------------------------------------------------ */

export type WithholdingStatus = 'refund' | 'owe' | 'balanced';
export type SafeHarborBasis =
  | '90% of current-year tax'
  | '100% of prior-year tax'
  | '110% of prior-year tax';

export interface WithholdingCheckupInput {
  year: TaxYear;
  filingStatus: FilingStatus;
  /** Fraction of the tax year elapsed as of the as-of date (0 < f <= 1). */
  elapsedYearFraction: number;
  /** Annualize YTD flows to a full-year projection. False treats YTD as full-year. */
  annualize: boolean;
  /** YTD federal tax engine inputs (un-annualized). */
  ytdInputs: FederalTaxInputs;
  /** YTD federal income tax withheld from paychecks. */
  ytdWithholding: number;
  /** YTD federal estimated (1040-ES) payments already made. */
  ytdEstimatedPayments: number;
  /** Prior-year total federal tax liability (safe harbor), or null. */
  priorYearTax: number | null;
  /** Prior-year AGI — determines the 110% high-income multiplier — or null. */
  priorYearAgi: number | null;
  /** Pay periods remaining in the year (drives the per-paycheck bump). */
  remainingPayPeriods: number | null;
  /** As-of date (YYYY-MM-DD) — picks the next quarterly due date. */
  asOfDate: string;
}

export interface WithholdingCheckup {
  year: TaxYear;
  filingStatus: FilingStatus;
  asOfDate: string;
  elapsedYearFraction: number;
  annualized: boolean;
  /** Whether there is enough mapped income/withholding to say anything. */
  hasData: boolean;
  /** Whether any withholding or estimated payment has been made YTD. */
  hasPayments: boolean;

  /** Annualized full-year engine inputs the projection ran on. */
  projectedInputs: FederalTaxInputs;
  /** Full federal engine result for the projected year. */
  federal: FederalTaxResult;

  projectedAgi: number;
  /** Projected year-end federal liability (federal.totalTax). */
  projectedLiability: number;
  /** Projected full-year withholding (YTD withholding at its run-rate). */
  projectedWithholding: number;
  ytdWithholding: number;
  ytdEstimatedPayments: number;
  /** projectedWithholding + estimated payments already made. */
  projectedTotalPayments: number;
  /** projectedTotalPayments - projectedLiability (positive = refund). */
  projectedBalance: number;
  status: WithholdingStatus;
  /** True when projected payments fall short of projected liability. */
  underWithheld: boolean;

  safeHarbor: SafeHarborResult;
  /** Which rule set the safe-harbor required annual payment. */
  safeHarborBasis: SafeHarborBasis;
  /** True when projected payments already meet the safe-harbor target. */
  meetsSafeHarbor: boolean;

  /** Safe-harbor estimated payments still owed after payments already made. */
  remainingEstimatedPayment: number;
  /** Next 1040-ES voucher after the as-of date, sized to the remaining need. */
  nextQuarter: QuarterlyPayment | null;

  /** Shortfall to the safe-harbor target (== remainingEstimatedPayment). */
  gapToSafeHarbor: number;
  /** Shortfall to fully covering the projected liability. */
  gapToFullLiability: number;
  remainingPayPeriods: number | null;
  /** Per-paycheck withholding increase to reach the safe-harbor target. */
  recommendedPerPaycheckBump: number | null;
  /** Per-paycheck withholding increase to fully cover the liability. */
  recommendedPerPaycheckBumpFull: number | null;
}

function resolveSafeHarborBasis(sh: SafeHarborResult): SafeHarborBasis {
  if (
    sh.priorYearSafeHarbor !== null &&
    sh.priorYearSafeHarbor < sh.ninetyPercentCurrent
  ) {
    return sh.priorYearMultiplier === 1.1
      ? '110% of prior-year tax'
      : '100% of prior-year tax';
  }
  return '90% of current-year tax';
}

/**
 * Project the year-end tax picture from YTD figures and classify withholding.
 * Pure — no I/O. Reuses computeFederalTax and computeSafeHarbor.
 */
export function computeWithholdingCheckup(input: WithholdingCheckupInput): WithholdingCheckup {
  const {
    year,
    filingStatus,
    elapsedYearFraction,
    annualize,
    ytdInputs,
    ytdWithholding,
    ytdEstimatedPayments,
    priorYearTax,
    priorYearAgi,
    remainingPayPeriods,
    asOfDate,
  } = input;

  const fraction = Math.min(1, Math.max(0.0001, elapsedYearFraction));
  const factor = annualize && fraction < 1 ? 1 / fraction : 1;

  const projectedInputs = annualizeInputs(ytdInputs, factor);
  const federal = computeFederalTax(projectedInputs);
  const projectedLiability = federal.totalTax;

  const projectedWithholding = round2(ytdWithholding * factor);
  const estimatedPaid = round2(Math.max(0, ytdEstimatedPayments));
  const projectedTotalPayments = round2(projectedWithholding + estimatedPaid);
  const projectedBalance = round2(projectedTotalPayments - projectedLiability);

  const status: WithholdingStatus =
    projectedBalance > 0.005 ? 'refund' : projectedBalance < -0.005 ? 'owe' : 'balanced';
  const underWithheld = projectedBalance < -0.005;

  // Safe harbor receives the projected full-year withholding (treated as paid
  // evenly through the year); its estimatedPaymentsNeeded is what is still due
  // via 1040-ES on top of that withholding.
  const safeHarbor = computeSafeHarbor({
    year,
    filingStatus,
    currentYearTax: projectedLiability,
    priorYearTax,
    priorYearAgi,
    withholding: projectedWithholding,
  });
  const safeHarborBasis = resolveSafeHarborBasis(safeHarbor);

  // Estimated payments already made further reduce what is still owed.
  const remainingEstimatedPayment = round2(
    Math.max(0, safeHarbor.estimatedPaymentsNeeded - estimatedPaid),
  );
  const meetsSafeHarbor = remainingEstimatedPayment <= 0.005;

  // Next voucher: first scheduled quarter whose due date is on/after as-of,
  // sized to the remaining need spread over the remaining quarters.
  const upcoming = safeHarbor.quarterlySchedule.filter(q => q.dueDate >= asOfDate);
  let nextQuarter: QuarterlyPayment | null = null;
  if (upcoming.length > 0 && remainingEstimatedPayment > 0.005) {
    const next = upcoming[0];
    nextQuarter = {
      quarter: next.quarter,
      dueDate: next.dueDate,
      amount: round2(remainingEstimatedPayment / upcoming.length),
    };
  }

  const gapToSafeHarbor = remainingEstimatedPayment;
  const gapToFullLiability = round2(Math.max(0, projectedLiability - projectedTotalPayments));

  const periods = remainingPayPeriods !== null && remainingPayPeriods > 0 ? remainingPayPeriods : null;
  const recommendedPerPaycheckBump =
    periods !== null && gapToSafeHarbor > 0.005 ? round2(gapToSafeHarbor / periods) : periods !== null ? 0 : null;
  const recommendedPerPaycheckBumpFull =
    periods !== null && gapToFullLiability > 0.005 ? round2(gapToFullLiability / periods) : periods !== null ? 0 : null;

  const hasData = federal.totalIncome > 0.005 || ytdWithholding > 0.005 || estimatedPaid > 0.005;
  const hasPayments = ytdWithholding + estimatedPaid > 0.005;

  return {
    year,
    filingStatus,
    asOfDate,
    elapsedYearFraction: Math.round(fraction * 10000) / 10000,
    annualized: factor > 1,
    hasData,
    hasPayments,
    projectedInputs,
    federal,
    projectedAgi: federal.agi,
    projectedLiability,
    projectedWithholding,
    ytdWithholding: round2(ytdWithholding),
    ytdEstimatedPayments: estimatedPaid,
    projectedTotalPayments,
    projectedBalance,
    status,
    underWithheld,
    safeHarbor,
    safeHarborBasis,
    meetsSafeHarbor,
    remainingEstimatedPayment,
    nextQuarter,
    gapToSafeHarbor,
    gapToFullLiability,
    remainingPayPeriods: periods,
    recommendedPerPaycheckBump,
    recommendedPerPaycheckBumpFull,
  };
}

/* ------------------------------------------------------------------ */
/* Pay-period inference                                                 */
/* ------------------------------------------------------------------ */

const COMMON_PAY_FREQUENCIES = [12, 24, 26, 52];

/**
 * Infer pay periods per year from the count of YTD payslips and the elapsed
 * year fraction, snapping to the nearest common cadence (monthly / semi-
 * monthly / biweekly / weekly). Falls back to biweekly (26) when there is
 * too little signal.
 */
export function inferPayPeriodsPerYear(payslipCount: number, elapsedYearFraction: number): number {
  const fraction = Math.min(1, Math.max(0.0001, elapsedYearFraction));
  if (payslipCount < 3) return 26;
  const impliedAnnual = payslipCount / fraction;
  let best = 26;
  let bestDist = Infinity;
  for (const freq of COMMON_PAY_FREQUENCIES) {
    const dist = Math.abs(freq - impliedAnnual);
    if (dist < bestDist) {
      bestDist = dist;
      best = freq;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* DB loader                                                           */
/* ------------------------------------------------------------------ */

export interface PayslipCorroboration {
  /** Number of payslips found in the tax year. */
  count: number;
  /** Sum of federal-withholding-looking tax line items (YTD), or null. */
  federalWithholding: number | null;
}

export interface WithholdingCheckupLoaderOptions {
  bookAccountGuids: string[];
  bookGuid: string;
  year: number;
  filingStatus: FilingStatus;
  birthday: string | null;
  filersAge65Plus?: number;
  annualize?: boolean;
  priorYearTax?: number | null;
  priorYearAgi?: number | null;
  /** Override the pay cadence; otherwise inferred from payslips (default 26). */
  payPeriodsPerYear?: number;
}

export interface WithholdingCheckupPayload {
  checkup: WithholdingCheckup;
  meta: {
    year: number;
    startDate: string;
    endDate: string;
    asOfDate: string;
    elapsedYearFraction: number;
    annualized: boolean;
    filingStatus: FilingStatus;
    priorYearTax: number | null;
    priorYearAgi: number | null;
    payPeriodsPerYear: number;
    remainingPayPeriods: number;
    ytdWithholding: number;
    ytdEstimatedPayments: number;
    mappedAccountCount: number;
    payslip: PayslipCorroboration | null;
  };
}

const FEDERAL_WH_LABEL = /fed(eral)?/i;
const NOT_FEDERAL_WH_LABEL = /state|medicare|social|oasdi|\bss\b|local|city|county|sdi|disability/i;

/**
 * Best-effort YTD federal withholding + pay cadence from stored payslips.
 * Corroborating source only — never throws (payslip tables may be absent).
 */
async function loadPayslipCorroboration(
  bookGuid: string,
  year: number,
): Promise<PayslipCorroboration | null> {
  try {
    const { default: prisma } = await import('@/lib/prisma');
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
    const rows = await prisma.gnucash_web_payslips.findMany({
      where: { book_guid: bookGuid, pay_date: { gte: start, lte: end } },
      select: { line_items: true },
    });
    if (rows.length === 0) return { count: 0, federalWithholding: null };

    let fedWithholding = 0;
    let sawTax = false;
    for (const row of rows) {
      const items = Array.isArray(row.line_items)
        ? (row.line_items as Array<{ category?: string; label?: string; normalized_label?: string; amount?: number }>)
        : [];
      for (const item of items) {
        if (item.category !== 'tax') continue;
        const label = `${item.label ?? ''} ${item.normalized_label ?? ''}`;
        if (FEDERAL_WH_LABEL.test(label) && !NOT_FEDERAL_WH_LABEL.test(label)) {
          fedWithholding += Math.abs(Number(item.amount) || 0);
          sawTax = true;
        }
      }
    }
    return {
      count: rows.length,
      federalWithholding: sawTax ? round2(fedWithholding) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Gather the YTD picture from the book and run the pure checkup.
 * Reuses aggregateBookTaxData (income + withholding + contributions) and
 * summarizeTaxPayments. Throws on an unsupported tax year (the engine only
 * supports the years in SUPPORTED_TAX_YEARS).
 */
export async function loadWithholdingCheckup(
  options: WithholdingCheckupLoaderOptions,
): Promise<WithholdingCheckupPayload> {
  const {
    bookAccountGuids,
    bookGuid,
    year,
    filingStatus,
    birthday,
    filersAge65Plus = 0,
    annualize = true,
    priorYearTax = null,
    priorYearAgi = null,
    payPeriodsPerYear,
  } = options;

  if (!isSupportedTaxYear(year)) {
    throw new Error(`Unsupported tax year ${year}`);
  }

  const bookData = await aggregateBookTaxData(bookAccountGuids, year, birthday);
  const ytdInputs = buildFederalInputsFromBook(bookData, year, filingStatus, filersAge65Plus);
  const payments = summarizeTaxPayments(bookData, 1);

  const payslip = await loadPayslipCorroboration(bookGuid, year);

  const resolvedPeriodsPerYear =
    payPeriodsPerYear && payPeriodsPerYear > 0
      ? Math.round(payPeriodsPerYear)
      : inferPayPeriodsPerYear(payslip?.count ?? 0, bookData.elapsedYearFraction);
  const remainingPayPeriods = Math.max(
    0,
    Math.round(resolvedPeriodsPerYear * (1 - bookData.elapsedYearFraction)),
  );

  const checkup = computeWithholdingCheckup({
    year,
    filingStatus,
    elapsedYearFraction: bookData.elapsedYearFraction,
    annualize,
    ytdInputs,
    ytdWithholding: payments.withholding,
    ytdEstimatedPayments: payments.estimatedPayments,
    priorYearTax,
    priorYearAgi,
    remainingPayPeriods,
    asOfDate: bookData.asOfDate,
  });

  return {
    checkup,
    meta: {
      year,
      startDate: bookData.startDate,
      endDate: bookData.endDate,
      asOfDate: bookData.asOfDate,
      elapsedYearFraction: bookData.elapsedYearFraction,
      annualized: checkup.annualized,
      filingStatus,
      priorYearTax,
      priorYearAgi,
      payPeriodsPerYear: resolvedPeriodsPerYear,
      remainingPayPeriods,
      ytdWithholding: payments.withholding,
      ytdEstimatedPayments: payments.estimatedPayments,
      mappedAccountCount: bookData.mappedAccountCount,
      payslip,
    },
  };
}
