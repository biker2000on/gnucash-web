/**
 * Federal income tax engine — pure functions, no I/O.
 *
 * Supports tax years 2024, 2025, 2026 and all five filing statuses.
 *
 * Verified figures:
 * - 2024: Rev. Proc. 2023-34
 * - 2025: Rev. Proc. 2024-40, amended by OBBBA (P.L. 119-21): standard
 *   deduction $15,750/$31,500/$23,625, senior deduction $6,000, SALT cap $40,000
 * - 2026: Rev. Proc. 2025-32 (https://www.irs.gov/pub/irs-drop/rp-25-32.pdf)
 * - SS wage base: 2024 $168,600 / 2025 $176,100 / 2026 $184,500 (SSA)
 *
 * ESTIMATES ONLY — not tax advice.
 */

import type {
  BracketFill,
  CapitalGainsBracketFill,
  FederalTaxInputs,
  FederalTaxResult,
  FilingStatus,
  SafeHarborInputs,
  SafeHarborResult,
  QuarterlyPayment,
  TaxYear,
} from './types';

/* ------------------------------------------------------------------ */
/* Year parameters                                                     */
/* ------------------------------------------------------------------ */

interface Bracket {
  rate: number;
  /** Upper bound of the bracket (Infinity for top) */
  upTo: number;
}

interface YearStatusParams {
  brackets: Bracket[];
  standardDeduction: number;
  /** Additional standard deduction per filer aged 65+ */
  additionalStdDed65: number;
  /** LTCG 0% band tops out here */
  ltcg0Max: number;
  /** LTCG 15% band tops out here */
  ltcg15Max: number;
  /** NIIT / Additional Medicare MAGI threshold */
  niitThreshold: number;
  /** SALT cap before any phase-down */
  saltCap: number;
  /** OBBBA SALT phase-down: starts at this MAGI (null when no phase-down) */
  saltPhaseDownStart: number | null;
  /** SALT floor after full phase-down */
  saltFloor: number;
  /** OBBBA senior deduction per qualifying filer (0 before 2025) */
  seniorDeductionPerFiler: number;
  /** Senior deduction MAGI phase-out start */
  seniorDeductionPhaseOutStart: number;
}

interface YearParams {
  ssWageBase: number;
  byStatus: Record<FilingStatus, YearStatusParams>;
}

function mk(
  brackets: Array<[number, number]>,
  standardDeduction: number,
  additionalStdDed65: number,
  ltcg0Max: number,
  ltcg15Max: number,
  niitThreshold: number,
  saltCap: number,
  saltPhaseDownStart: number | null,
  saltFloor: number,
  seniorDeductionPerFiler: number,
  seniorDeductionPhaseOutStart: number,
): YearStatusParams {
  return {
    brackets: brackets.map(([rate, upTo]) => ({ rate, upTo })),
    standardDeduction,
    additionalStdDed65,
    ltcg0Max,
    ltcg15Max,
    niitThreshold,
    saltCap,
    saltPhaseDownStart,
    saltFloor,
    seniorDeductionPerFiler,
    seniorDeductionPhaseOutStart,
  };
}

const INF = Infinity;

const PARAMS: Record<TaxYear, YearParams> = {
  2024: {
    ssWageBase: 168_600,
    byStatus: {
      single: mk(
        [[0.10, 11_600], [0.12, 47_150], [0.22, 100_525], [0.24, 191_950], [0.32, 243_725], [0.35, 609_350], [0.37, INF]],
        14_600, 1_950, 47_025, 518_900, 200_000, 10_000, null, 10_000, 0, 75_000,
      ),
      mfj: mk(
        [[0.10, 23_200], [0.12, 94_300], [0.22, 201_050], [0.24, 383_900], [0.32, 487_450], [0.35, 731_200], [0.37, INF]],
        29_200, 1_550, 94_050, 583_750, 250_000, 10_000, null, 10_000, 0, 150_000,
      ),
      mfs: mk(
        [[0.10, 11_600], [0.12, 47_150], [0.22, 100_525], [0.24, 191_950], [0.32, 243_725], [0.35, 365_600], [0.37, INF]],
        14_600, 1_550, 47_025, 291_850, 125_000, 5_000, null, 5_000, 0, 75_000,
      ),
      hoh: mk(
        [[0.10, 16_550], [0.12, 63_100], [0.22, 100_500], [0.24, 191_950], [0.32, 243_700], [0.35, 609_350], [0.37, INF]],
        21_900, 1_950, 63_000, 551_350, 200_000, 10_000, null, 10_000, 0, 75_000,
      ),
      qss: mk(
        [[0.10, 23_200], [0.12, 94_300], [0.22, 201_050], [0.24, 383_900], [0.32, 487_450], [0.35, 731_200], [0.37, INF]],
        29_200, 1_550, 94_050, 583_750, 250_000, 10_000, null, 10_000, 0, 150_000,
      ),
    },
  },
  2025: {
    ssWageBase: 176_100,
    byStatus: {
      single: mk(
        [[0.10, 11_925], [0.12, 48_475], [0.22, 103_350], [0.24, 197_300], [0.32, 250_525], [0.35, 626_350], [0.37, INF]],
        15_750, 2_000, 48_350, 533_400, 200_000, 40_000, 500_000, 10_000, 6_000, 75_000,
      ),
      mfj: mk(
        [[0.10, 23_850], [0.12, 96_950], [0.22, 206_700], [0.24, 394_600], [0.32, 501_050], [0.35, 751_600], [0.37, INF]],
        31_500, 1_600, 96_700, 600_050, 250_000, 40_000, 500_000, 10_000, 6_000, 150_000,
      ),
      mfs: mk(
        [[0.10, 11_925], [0.12, 48_475], [0.22, 103_350], [0.24, 197_300], [0.32, 250_525], [0.35, 375_800], [0.37, INF]],
        15_750, 1_600, 48_350, 300_000, 125_000, 20_000, 250_000, 5_000, 0, 75_000,
      ),
      hoh: mk(
        [[0.10, 17_000], [0.12, 64_850], [0.22, 103_350], [0.24, 197_300], [0.32, 250_500], [0.35, 626_350], [0.37, INF]],
        23_625, 2_000, 64_750, 566_700, 200_000, 40_000, 500_000, 10_000, 6_000, 75_000,
      ),
      qss: mk(
        [[0.10, 23_850], [0.12, 96_950], [0.22, 206_700], [0.24, 394_600], [0.32, 501_050], [0.35, 751_600], [0.37, INF]],
        31_500, 1_600, 96_700, 600_050, 250_000, 40_000, 500_000, 10_000, 6_000, 150_000,
      ),
    },
  },
  2026: {
    ssWageBase: 184_500,
    byStatus: {
      single: mk(
        [[0.10, 12_400], [0.12, 50_400], [0.22, 105_700], [0.24, 201_775], [0.32, 256_225], [0.35, 640_600], [0.37, INF]],
        16_100, 2_050, 49_450, 545_500, 200_000, 40_400, 505_000, 10_000, 6_000, 75_000,
      ),
      mfj: mk(
        [[0.10, 24_800], [0.12, 100_800], [0.22, 211_400], [0.24, 403_550], [0.32, 512_450], [0.35, 768_700], [0.37, INF]],
        32_200, 1_650, 98_900, 613_700, 250_000, 40_400, 505_000, 10_000, 6_000, 150_000,
      ),
      mfs: mk(
        [[0.10, 12_400], [0.12, 50_400], [0.22, 105_700], [0.24, 201_775], [0.32, 256_225], [0.35, 384_350], [0.37, INF]],
        16_100, 1_650, 49_450, 306_850, 125_000, 20_200, 252_500, 5_000, 0, 75_000,
      ),
      hoh: mk(
        [[0.10, 17_700], [0.12, 67_450], [0.22, 105_700], [0.24, 201_775], [0.32, 256_200], [0.35, 640_600], [0.37, INF]],
        24_150, 2_050, 66_200, 579_600, 200_000, 40_400, 505_000, 10_000, 6_000, 75_000,
      ),
      qss: mk(
        [[0.10, 24_800], [0.12, 100_800], [0.22, 211_400], [0.24, 403_550], [0.32, 512_450], [0.35, 768_700], [0.37, INF]],
        32_200, 1_650, 98_900, 613_700, 250_000, 40_400, 505_000, 10_000, 6_000, 150_000,
      ),
    },
  },
};

export function getYearStatusParams(year: TaxYear, status: FilingStatus): YearStatusParams {
  return PARAMS[year].byStatus[status];
}

export function getSsWageBase(year: TaxYear): number {
  return PARAMS[year].ssWageBase;
}

const SE_NET_FACTOR = 0.9235;
const SE_SS_RATE = 0.124;
const SE_MEDICARE_RATE = 0.029;
const NIIT_RATE = 0.038;
const ADDL_MEDICARE_RATE = 0.009;
const MEDICAL_AGI_FLOOR = 0.075;

const round2 = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Bracket math                                                        */
/* ------------------------------------------------------------------ */

/** Tax on `amount` of ordinary income using a bracket schedule. */
export function taxFromBrackets(amount: number, brackets: Bracket[]): number {
  let tax = 0;
  let prev = 0;
  for (const b of brackets) {
    if (amount <= prev) break;
    const inBracket = Math.min(amount, b.upTo) - prev;
    tax += inBracket * b.rate;
    prev = b.upTo;
  }
  return tax;
}

function buildBracketFills(amount: number, brackets: Bracket[]): BracketFill[] {
  const fills: BracketFill[] = [];
  let prev = 0;
  for (const b of brackets) {
    const inBracket = Math.max(0, Math.min(amount, b.upTo) - prev);
    fills.push({
      rate: b.rate,
      bracketStart: prev,
      bracketEnd: b.upTo === INF ? null : b.upTo,
      amountInBracket: round2(inBracket),
      taxInBracket: round2(inBracket * b.rate),
    });
    prev = b.upTo;
    if (prev === INF) break;
  }
  return fills;
}

/* ------------------------------------------------------------------ */
/* Self-employment tax (Schedule SE)                                   */
/* ------------------------------------------------------------------ */

export interface SeTaxResult {
  netEarningsFromSe: number;
  socialSecurityPortion: number;
  medicarePortion: number;
  total: number;
  halfDeduction: number;
}

/**
 * Schedule SE. W-2 social security wages reduce the remaining SS wage base
 * available to self-employment earnings.
 */
export function computeSeTax(
  seIncome: number,
  year: TaxYear,
  w2SocialSecurityWages: number = 0,
): SeTaxResult {
  const net = seIncome > 0 ? seIncome * SE_NET_FACTOR : 0;
  if (net < 400) {
    return { netEarningsFromSe: round2(net), socialSecurityPortion: 0, medicarePortion: 0, total: 0, halfDeduction: 0 };
  }
  const wageBase = PARAMS[year].ssWageBase;
  const remainingBase = Math.max(0, wageBase - Math.max(0, w2SocialSecurityWages));
  const ssPortion = Math.min(net, remainingBase) * SE_SS_RATE;
  const medicarePortion = net * SE_MEDICARE_RATE;
  const total = ssPortion + medicarePortion;
  return {
    netEarningsFromSe: round2(net),
    socialSecurityPortion: round2(ssPortion),
    medicarePortion: round2(medicarePortion),
    total: round2(total),
    halfDeduction: round2(total / 2),
  };
}

/* ------------------------------------------------------------------ */
/* Taxable Social Security (simplified IRS worksheet)                  */
/* ------------------------------------------------------------------ */

export function computeTaxableSocialSecurity(
  benefits: number,
  otherIncome: number,
  filingStatus: FilingStatus,
): number {
  if (benefits <= 0) return 0;
  const base1 = filingStatus === 'mfj' || filingStatus === 'qss' ? 32_000 : filingStatus === 'mfs' ? 0 : 25_000;
  const base2 = filingStatus === 'mfj' || filingStatus === 'qss' ? 44_000 : filingStatus === 'mfs' ? 0 : 34_000;
  const provisional = otherIncome + benefits / 2;
  if (provisional <= base1) return 0;
  if (provisional <= base2) {
    return round2(Math.min(0.5 * (provisional - base1), 0.5 * benefits));
  }
  const tier1 = Math.min(0.5 * (base2 - base1), 0.5 * benefits);
  const tier2 = 0.85 * (provisional - base2);
  return round2(Math.min(tier1 + tier2, 0.85 * benefits));
}

/* ------------------------------------------------------------------ */
/* Capital gain netting                                                */
/* ------------------------------------------------------------------ */

export interface CapitalGainNetting {
  /** Amount of capital gain/loss included in AGI (loss capped at -3000, -1500 MFS) */
  includedInAgi: number;
  /** Net LTCG eligible for preferential rates (>= 0) */
  preferentialLtcg: number;
  /** ST gain taxed as ordinary (>= 0) */
  ordinaryStcg: number;
}

export function netCapitalGains(
  shortTerm: number,
  longTerm: number,
  filingStatus: FilingStatus,
): CapitalGainNetting {
  const lossLimit = filingStatus === 'mfs' ? -1_500 : -3_000;
  let st = shortTerm;
  let lt = longTerm;
  // Cross-netting: losses offset gains of the other character
  if (st < 0 && lt > 0) {
    const offset = Math.min(-st, lt);
    lt -= offset;
    st += offset;
  } else if (lt < 0 && st > 0) {
    const offset = Math.min(-lt, st);
    st -= offset;
    lt += offset;
  }
  const totalNet = st + lt;
  if (totalNet < 0) {
    return { includedInAgi: Math.max(totalNet, lossLimit), preferentialLtcg: 0, ordinaryStcg: 0 };
  }
  return {
    includedInAgi: totalNet,
    preferentialLtcg: Math.max(0, lt),
    ordinaryStcg: Math.max(0, st),
  };
}

/* ------------------------------------------------------------------ */
/* Main engine                                                         */
/* ------------------------------------------------------------------ */

export function computeFederalTax(inputs: FederalTaxInputs): FederalTaxResult {
  const p = PARAMS[inputs.year].byStatus[inputs.filingStatus];

  /* --- SE tax (needed before AGI for the half-SE deduction) --- */
  const se = computeSeTax(inputs.selfEmploymentIncome, inputs.year, inputs.wages);

  /* --- Capital gain netting --- */
  const cg = netCapitalGains(inputs.shortTermCapitalGains, inputs.longTermCapitalGains, inputs.filingStatus);

  /* --- Income before Social Security taxability --- */
  const qualifiedDividends = Math.min(Math.max(0, inputs.qualifiedDividends), Math.max(0, inputs.ordinaryDividends));
  const incomeExSs =
    inputs.wages +
    inputs.interest +
    inputs.ordinaryDividends +
    cg.includedInAgi +
    Math.max(0, inputs.selfEmploymentIncome) +
    inputs.rentalIncome +
    inputs.retirementIncome +
    inputs.otherIncome;

  /* --- Adjustments (above the line) --- */
  const adjustments =
    Math.max(0, inputs.traditional401kContributions) +
    Math.max(0, inputs.traditionalIraContributions) +
    Math.max(0, inputs.hsaContributions) +
    se.halfDeduction;

  /* --- Taxable Social Security (worksheet uses income net of adjustments) --- */
  const taxableSs = computeTaxableSocialSecurity(
    inputs.socialSecurityBenefits,
    Math.max(0, incomeExSs - adjustments),
    inputs.filingStatus,
  );

  const totalIncome = incomeExSs + taxableSs;
  const agi = totalIncome - adjustments;

  /* --- Standard deduction --- */
  const filers65 = Math.max(0, Math.min(2, Math.floor(inputs.filersAge65Plus)));
  const standardDeduction = p.standardDeduction + filers65 * p.additionalStdDed65;

  /* --- Itemized deduction --- */
  let saltCap = p.saltCap;
  if (p.saltPhaseDownStart !== null && agi > p.saltPhaseDownStart) {
    // OBBBA: cap reduced by 30% of MAGI over threshold, floored
    saltCap = Math.max(p.saltFloor, p.saltCap - 0.3 * (agi - p.saltPhaseDownStart));
  }
  const saltAllowed = Math.min(Math.max(0, inputs.stateLocalTaxesPaid), saltCap);
  const medicalAllowed = Math.max(0, inputs.medicalExpenses - MEDICAL_AGI_FLOOR * Math.max(0, agi));
  const itemizedBreakdown = {
    saltAllowed: round2(saltAllowed),
    saltCap: round2(saltCap),
    mortgageInterest: round2(Math.max(0, inputs.mortgageInterest)),
    charitable: round2(Math.max(0, inputs.charitableDonations)),
    medicalAllowed: round2(medicalAllowed),
    other: round2(Math.max(0, inputs.otherDeductions)),
  };
  const itemizedDeduction =
    itemizedBreakdown.saltAllowed +
    itemizedBreakdown.mortgageInterest +
    itemizedBreakdown.charitable +
    itemizedBreakdown.medicalAllowed +
    itemizedBreakdown.other;

  const usedItemized = itemizedDeduction > standardDeduction;
  const deductionTaken = usedItemized ? itemizedDeduction : standardDeduction;

  /* --- OBBBA senior deduction (2025-2028), applies on top of either --- */
  let seniorDeduction = 0;
  if (p.seniorDeductionPerFiler > 0 && filers65 > 0) {
    const gross = p.seniorDeductionPerFiler * filers65;
    const phaseOut = Math.max(0, agi - p.seniorDeductionPhaseOutStart) * 0.06;
    seniorDeduction = Math.max(0, gross - phaseOut);
  }

  const taxableIncome = Math.max(0, agi - deductionTaken - seniorDeduction);

  /* --- Ordinary vs preferential split --- */
  const preferentialIncome = Math.min(taxableIncome, cg.preferentialLtcg + qualifiedDividends);
  const ordinaryTaxableIncome = taxableIncome - preferentialIncome;

  /* --- Ordinary tax --- */
  const ordinaryTax = taxFromBrackets(ordinaryTaxableIncome, p.brackets);
  const ordinaryBracketFills = buildBracketFills(ordinaryTaxableIncome, p.brackets);

  /* --- LTCG / qualified dividends — stacked on top of ordinary income --- */
  const zeroBand = Math.max(0, Math.min(taxableIncome, p.ltcg0Max) - ordinaryTaxableIncome);
  const fifteenBand = Math.max(0, Math.min(taxableIncome, p.ltcg15Max) - ordinaryTaxableIncome - zeroBand);
  const at0 = Math.min(preferentialIncome, zeroBand);
  const at15 = Math.min(preferentialIncome - at0, fifteenBand);
  const at20 = Math.max(0, preferentialIncome - at0 - at15);
  const capitalGainsTax = at15 * 0.15 + at20 * 0.20;
  const capitalGainsBracketFills: CapitalGainsBracketFill[] = [
    { rate: 0, amountInBracket: round2(at0), taxInBracket: 0 },
    { rate: 0.15, amountInBracket: round2(at15), taxInBracket: round2(at15 * 0.15) },
    { rate: 0.20, amountInBracket: round2(at20), taxInBracket: round2(at20 * 0.20) },
  ];

  /* --- NIIT --- */
  const netInvestmentIncome = Math.max(
    0,
    inputs.interest + inputs.ordinaryDividends + Math.max(0, cg.includedInAgi) + Math.max(0, inputs.rentalIncome),
  );
  const magi = agi; // common case: MAGI == AGI
  const niit = NIIT_RATE * Math.min(netInvestmentIncome, Math.max(0, magi - p.niitThreshold));

  /* --- Additional Medicare 0.9% --- */
  const medicareEarnings = Math.max(0, inputs.wages) + se.netEarningsFromSe;
  const additionalMedicareTax = ADDL_MEDICARE_RATE * Math.max(0, medicareEarnings - p.niitThreshold);

  const credits = 0; // placeholder for v1
  const totalTax = Math.max(
    0,
    ordinaryTax + capitalGainsTax + niit + additionalMedicareTax + se.total - credits,
  );

  /* --- Marginal rate on the last dollar of ordinary income --- */
  let marginalRate = 0;
  let prev = 0;
  for (const b of p.brackets) {
    if (ordinaryTaxableIncome > prev) marginalRate = b.rate;
    prev = b.upTo;
    if (prev === INF) break;
  }
  if (ordinaryTaxableIncome <= 0 && preferentialIncome > 0) {
    marginalRate = at20 > 0 ? 0.20 : at15 > 0 ? 0.15 : 0;
  }

  const effectiveRate = agi > 0 ? totalTax / agi : 0;

  return {
    year: inputs.year,
    filingStatus: inputs.filingStatus,
    totalIncome: round2(totalIncome),
    adjustments: round2(adjustments),
    halfSeTaxDeduction: se.halfDeduction,
    agi: round2(agi),
    taxableSocialSecurity: taxableSs,
    standardDeduction: round2(standardDeduction),
    itemizedDeduction: round2(itemizedDeduction),
    itemizedBreakdown,
    usedItemized,
    deductionTaken: round2(deductionTaken),
    seniorDeduction: round2(seniorDeduction),
    taxableIncome: round2(taxableIncome),
    ordinaryTaxableIncome: round2(ordinaryTaxableIncome),
    preferentialIncome: round2(preferentialIncome),
    ordinaryTax: round2(ordinaryTax),
    capitalGainsTax: round2(capitalGainsTax),
    selfEmploymentTax: se.total,
    niit: round2(niit),
    additionalMedicareTax: round2(additionalMedicareTax),
    credits,
    totalTax: round2(totalTax),
    marginalRate,
    effectiveRate: round2(effectiveRate * 10000) / 10000,
    ordinaryBracketFills,
    capitalGainsBracketFills,
  };
}

/* ------------------------------------------------------------------ */
/* Safe harbor + quarterly 1040-ES schedule                            */
/* ------------------------------------------------------------------ */

const HIGH_AGI_THRESHOLD = 150_000;
const HIGH_AGI_THRESHOLD_MFS = 75_000;

export function computeSafeHarbor(inputs: SafeHarborInputs): SafeHarborResult {
  const ninetyPercentCurrent = round2(0.9 * Math.max(0, inputs.currentYearTax));

  let priorYearSafeHarbor: number | null = null;
  let priorYearMultiplier: number | null = null;
  if (inputs.priorYearTax !== null && inputs.priorYearTax >= 0) {
    const highAgiThreshold = inputs.filingStatus === 'mfs' ? HIGH_AGI_THRESHOLD_MFS : HIGH_AGI_THRESHOLD;
    priorYearMultiplier =
      inputs.priorYearAgi !== null && inputs.priorYearAgi > highAgiThreshold ? 1.1 : 1.0;
    priorYearSafeHarbor = round2(inputs.priorYearTax * priorYearMultiplier);
  }

  const requiredAnnualPayment =
    priorYearSafeHarbor !== null
      ? Math.min(ninetyPercentCurrent, priorYearSafeHarbor)
      : ninetyPercentCurrent;

  const withholding = Math.max(0, inputs.withholding);
  const estimatedPaymentsNeeded = round2(Math.max(0, requiredAnnualPayment - withholding));
  const balanceDueAfterWithholding = Math.max(0, inputs.currentYearTax - withholding);
  const underThousandDollarRule = balanceDueAfterWithholding < 1_000;

  const perQuarter = round2(estimatedPaymentsNeeded / 4);
  const y = inputs.year;
  const quarterlySchedule: QuarterlyPayment[] = [
    { quarter: 1, dueDate: `${y}-04-15`, amount: perQuarter },
    { quarter: 2, dueDate: `${y}-06-15`, amount: perQuarter },
    { quarter: 3, dueDate: `${y}-09-15`, amount: perQuarter },
    { quarter: 4, dueDate: `${y + 1}-01-15`, amount: round2(estimatedPaymentsNeeded - perQuarter * 3) },
  ];

  return {
    ninetyPercentCurrent,
    priorYearSafeHarbor,
    priorYearMultiplier,
    requiredAnnualPayment: round2(requiredAnnualPayment),
    withholding: round2(withholding),
    estimatedPaymentsNeeded,
    underThousandDollarRule,
    quarterlySchedule,
  };
}

/** Convenience: empty inputs with everything zeroed */
export function emptyFederalInputs(year: TaxYear, filingStatus: FilingStatus): FederalTaxInputs {
  return {
    year,
    filingStatus,
    wages: 0,
    interest: 0,
    ordinaryDividends: 0,
    qualifiedDividends: 0,
    shortTermCapitalGains: 0,
    longTermCapitalGains: 0,
    selfEmploymentIncome: 0,
    rentalIncome: 0,
    retirementIncome: 0,
    socialSecurityBenefits: 0,
    otherIncome: 0,
    traditional401kContributions: 0,
    traditionalIraContributions: 0,
    hsaContributions: 0,
    charitableDonations: 0,
    mortgageInterest: 0,
    stateLocalTaxesPaid: 0,
    medicalExpenses: 0,
    otherDeductions: 0,
    filersAge65Plus: 0,
  };
}
