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
 * - Additional Medicare thresholds (IRC §1401(b)(2)/§3101(b)(2), NOT indexed):
 *   $250,000 MFJ, $125,000 MFS, $200,000 any other case — QSS included.
 *
 * OBBBA INDIVIDUAL PROVISIONS (verified against IRC §224/§225/§163(h)(4)/
 * §170(p)/(q)/§68 as amended by P.L. 119-21, IRS Notice 2025-69, and the 2025
 * Schedule 1-A):
 * - Tips deduction (§224, 2025-2028): up to $25,000 per return; reduced $100
 *   for each FULL $1,000 of MAGI over $150,000 ($300,000 joint) — the statute
 *   has no "or fraction thereof", and Schedule 1-A rounds the quotient DOWN.
 *   Married taxpayers must file jointly (§224(f)) — MFS gets $0.
 * - Overtime deduction (§225, 2025-2028): up to $12,500 ($25,000 joint) for
 *   the FLSA §7 half-time premium portion only; same phase-out and MFS
 *   exclusion as tips.
 * - Car-loan interest (§163(h)(4), 2025-2028): up to $10,000 per return (NOT
 *   doubled for MFJ); reduced $200 for each $1,000 "or portion thereof" of
 *   MAGI over $100,000 ($200,000 joint) — Schedule 1-A rounds UP. No joint
 *   filing requirement; MFS uses the $100,000 threshold.
 * - Charitable (2026+, permanent): itemizers deduct only contributions above
 *   a 0.5%-of-AGI floor (§170(q)); non-itemizers deduct up to $1,000 ($2,000
 *   joint) of cash gifts (§170(p)).
 * - §68 (2026+): itemized deductions are reduced by 2/37 of the lesser of
 *   (a) itemized deductions or (b) taxable income (computed without §68 and
 *   INCREASED by those itemized deductions) over the 37%-bracket start.
 *
 * OBBBA SIMPLIFICATIONS (deliberate):
 * - MAGI for §224/§225/§163(h)(4) is taken as AGI — the §911/§931/§933
 *   foreign-income add-backs are not modeled (no input exists for them).
 * - The SSN requirement (§224(e)/§225(d)), the Treasury tipped-occupation
 *   list, the non-SSTB employer test, and the SE-income tips limit
 *   (§224(c)) are NOT verified — the user attests the amount is qualified.
 * - Car-loan interest: new-vehicle/original-use, US final assembly, and the
 *   VIN reporting requirement are NOT verified — user attests qualification.
 * - "Joint return" doubled amounts apply to MFJ only; QSS is not a joint
 *   return and gets the single-filer figures (same reading as
 *   additionalMedicareThreshold).
 * - §170(p) requires CASH gifts to non-DAF/non-supporting-org charities;
 *   the single charitable input is assumed to qualify. §170(q) floored
 *   amounts and §170(d) carryovers are not tracked across years.
 * - §68: the itemize-vs-standard election is made BEFORE the 2/37 reduction;
 *   measure (b) uses taxable income computed with the unreduced itemized
 *   deduction (two-pass, no fixed-point iteration on the QBI limit).
 *
 * §199A (qualified business income) SIMPLIFICATIONS — see computeQbiDeduction:
 * - Only the BELOW-THRESHOLD case is modeled: 20% of QBI, limited to 20% of
 *   (taxable income before QBI − net capital gain). The SSTB phase-out and the
 *   W-2 wage / UBIA-of-qualified-property limitations that apply above the
 *   §199A threshold ($197,300 single / $394,600 MFJ for 2025) are NOT applied,
 *   because this estimator has no input for W-2 wages PAID BY the business, the
 *   unadjusted basis of its qualified property, or whether it is a specified
 *   service trade or business. Above-threshold filers will see the deduction
 *   OVERSTATED.
 * - QBI is taken as Schedule C/F net profit reduced by the deductible half of
 *   SE tax. Self-employed health insurance and self-employed retirement plan
 *   contributions are NOT netted out of QBI (they should be), and rental
 *   income is NOT treated as QBI (it may be, under the Rev. Proc. 2019-38 safe
 *   harbor). Qualified REIT dividends and PTP income are not modeled.
 *
 * ESTIMATES ONLY — not tax advice.
 */

import { adjustDueDate } from '@/lib/compliance';
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

/* --- OBBBA individual provisions (P.L. 119-21) — statutory, not indexed --- */
/** §224/§225 first and last applicable tax years. */
const TIPS_OT_CAR_FIRST_YEAR = 2025;
const TIPS_OT_CAR_LAST_YEAR = 2028;
/** §224(b)(1): tips deduction cap, per return (not doubled for joint). */
const TIPS_DEDUCTION_CAP = 25_000;
/** §225(b)(1): overtime deduction cap ($25,000 in the case of a joint return). */
const OVERTIME_DEDUCTION_CAP = 12_500;
const OVERTIME_DEDUCTION_CAP_JOINT = 25_000;
/** §224(b)(2)/§225(b)(2): MAGI phase-out start ($300,000 joint). */
const TIPS_OT_PHASE_OUT_START = 150_000;
const TIPS_OT_PHASE_OUT_START_JOINT = 300_000;
/** Reduction per full $1,000 of excess MAGI (no "fraction thereof" — floor). */
const TIPS_OT_PHASE_OUT_PER_1000 = 100;
/** §163(h)(4): car-loan interest cap, per return (not doubled for joint). */
const CAR_LOAN_INTEREST_CAP = 10_000;
/** §163(h)(4) MAGI phase-out start ($200,000 joint). */
const CAR_LOAN_PHASE_OUT_START = 100_000;
const CAR_LOAN_PHASE_OUT_START_JOINT = 200_000;
/** Reduction per $1,000 "or portion thereof" of excess MAGI (ceiling). */
const CAR_LOAN_PHASE_OUT_PER_1000 = 200;
/** First year of the §170(p)/(q) charitable rules and the §68 limitation. */
const CHARITY_AND_SECTION_68_FIRST_YEAR = 2026;
/** §170(q): itemized charitable floor as a fraction of AGI. */
const CHARITABLE_FLOOR_RATE = 0.005;
/** §170(p): non-itemizer cash charitable cap ($2,000 in a joint return). */
const NON_ITEMIZER_CHARITABLE_CAP = 1_000;
const NON_ITEMIZER_CHARITABLE_CAP_JOINT = 2_000;
/** §68(a): itemized deductions reduced by 2/37 of the lesser-of measure. */
const ITEMIZED_LIMITATION_FRACTION = 2 / 37;

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
  /** Loss beyond the annual cap, carried forward to next year (>= 0). */
  carryoverToNextYear: number;
}

/**
 * Schedule D netting.
 *
 * @param priorYearCapitalLossCarryover Prior-year loss carryover (POSITIVE
 *   number). Simplification: applied as a LONG-TERM loss (offsets LTCG first,
 *   then STCG via cross-netting) rather than tracking ST/LT character
 *   separately.
 */
export function netCapitalGains(
  shortTerm: number,
  longTerm: number,
  filingStatus: FilingStatus,
  priorYearCapitalLossCarryover: number = 0,
): CapitalGainNetting {
  const lossLimit = filingStatus === 'mfs' ? -1_500 : -3_000;
  let st = shortTerm;
  let lt = longTerm - Math.max(0, priorYearCapitalLossCarryover);
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
    const includedInAgi = Math.max(totalNet, lossLimit);
    return {
      includedInAgi,
      preferentialLtcg: 0,
      ordinaryStcg: 0,
      carryoverToNextYear: round2(includedInAgi - totalNet),
    };
  }
  return {
    includedInAgi: totalNet,
    preferentialLtcg: Math.max(0, lt),
    ordinaryStcg: Math.max(0, st),
    carryoverToNextYear: 0,
  };
}

/* ------------------------------------------------------------------ */
/* OBBBA individual deductions (§224 tips, §225 overtime, §163(h)(4))  */
/* ------------------------------------------------------------------ */

/** "In the case of a joint return" — MFJ only; QSS is not a joint return. */
function isJointReturn(filingStatus: FilingStatus): boolean {
  return filingStatus === 'mfj';
}

/**
 * §224 qualified tips deduction (2025-2028): min(tips, $25,000) reduced by
 * $100 for each FULL $1,000 of MAGI over $150,000 ($300,000 joint) —
 * Schedule 1-A rounds the quotient down. Married-filing-separately is
 * statutorily excluded (§224(f) requires a joint return when married).
 */
export function computeTipsDeduction(
  qualifiedTipIncome: number,
  magi: number,
  filingStatus: FilingStatus,
  year: TaxYear,
): number {
  if (year < TIPS_OT_CAR_FIRST_YEAR || year > TIPS_OT_CAR_LAST_YEAR) return 0;
  if (filingStatus === 'mfs') return 0;
  const capped = Math.min(Math.max(0, qualifiedTipIncome), TIPS_DEDUCTION_CAP);
  if (capped <= 0) return 0;
  const start = isJointReturn(filingStatus)
    ? TIPS_OT_PHASE_OUT_START_JOINT
    : TIPS_OT_PHASE_OUT_START;
  const reduction = Math.floor(Math.max(0, magi - start) / 1_000) * TIPS_OT_PHASE_OUT_PER_1000;
  return round2(Math.max(0, capped - reduction));
}

/**
 * §225 qualified overtime deduction (2025-2028): min(overtime premium,
 * $12,500 / $25,000 joint) with the same MAGI phase-out and MFS exclusion
 * as §224. The input must be the FLSA §7 HALF-TIME PREMIUM portion only.
 */
export function computeOvertimeDeduction(
  qualifiedOvertimeCompensation: number,
  magi: number,
  filingStatus: FilingStatus,
  year: TaxYear,
): number {
  if (year < TIPS_OT_CAR_FIRST_YEAR || year > TIPS_OT_CAR_LAST_YEAR) return 0;
  if (filingStatus === 'mfs') return 0;
  const cap = isJointReturn(filingStatus)
    ? OVERTIME_DEDUCTION_CAP_JOINT
    : OVERTIME_DEDUCTION_CAP;
  const capped = Math.min(Math.max(0, qualifiedOvertimeCompensation), cap);
  if (capped <= 0) return 0;
  const start = isJointReturn(filingStatus)
    ? TIPS_OT_PHASE_OUT_START_JOINT
    : TIPS_OT_PHASE_OUT_START;
  const reduction = Math.floor(Math.max(0, magi - start) / 1_000) * TIPS_OT_PHASE_OUT_PER_1000;
  return round2(Math.max(0, capped - reduction));
}

/**
 * §163(h)(4) qualified passenger vehicle loan interest (2025-2028):
 * min(interest, $10,000 per return) reduced by $200 for each $1,000 "or
 * portion thereof" (ceiling) of MAGI over $100,000 ($200,000 joint). No
 * joint-filing requirement — MFS is allowed at the $100,000 threshold.
 */
export function computeCarLoanInterestDeduction(
  qualifiedCarLoanInterest: number,
  magi: number,
  filingStatus: FilingStatus,
  year: TaxYear,
): number {
  if (year < TIPS_OT_CAR_FIRST_YEAR || year > TIPS_OT_CAR_LAST_YEAR) return 0;
  const capped = Math.min(Math.max(0, qualifiedCarLoanInterest), CAR_LOAN_INTEREST_CAP);
  if (capped <= 0) return 0;
  const start = isJointReturn(filingStatus)
    ? CAR_LOAN_PHASE_OUT_START_JOINT
    : CAR_LOAN_PHASE_OUT_START;
  const reduction = Math.ceil(Math.max(0, magi - start) / 1_000) * CAR_LOAN_PHASE_OUT_PER_1000;
  return round2(Math.max(0, capped - reduction));
}

/* ------------------------------------------------------------------ */
/* §199A qualified business income deduction                           */
/* ------------------------------------------------------------------ */

/** Additional Medicare (0.9%) MAGI threshold — statutory, never indexed. */
export function additionalMedicareThreshold(filingStatus: FilingStatus): number {
  if (filingStatus === 'mfj') return 250_000;
  if (filingStatus === 'mfs') return 125_000;
  // IRC §3101(b)(2)(C) "any other case" — single, HOH, and QSS.
  return 200_000;
}

/**
 * Simplified §199A deduction (Form 8995, below the threshold):
 *   min( 20% × QBI, 20% × (taxable income before QBI − net capital gain) )
 *
 * See the file header for everything this deliberately does not model.
 *
 * @param qualifiedBusinessIncome Net qualified business income (>= 0).
 * @param taxableIncomeBeforeQbi  AGI less the standard/itemized and senior deductions.
 * @param netCapitalGain          Net LTCG + qualified dividends (Form 8995 line 12).
 */
export function computeQbiDeduction(
  qualifiedBusinessIncome: number,
  taxableIncomeBeforeQbi: number,
  netCapitalGain: number,
): number {
  const qbi = Math.max(0, qualifiedBusinessIncome);
  if (qbi <= 0) return 0;
  const incomeLimit = Math.max(0, taxableIncomeBeforeQbi - Math.max(0, netCapitalGain));
  return round2(Math.min(0.20 * qbi, 0.20 * incomeLimit));
}

/* ------------------------------------------------------------------ */
/* Main engine                                                         */
/* ------------------------------------------------------------------ */

export function computeFederalTax(inputs: FederalTaxInputs): FederalTaxResult {
  const p = PARAMS[inputs.year].byStatus[inputs.filingStatus];

  /* --- SE tax (needed before AGI for the half-SE deduction) --- */
  const se = computeSeTax(inputs.selfEmploymentIncome, inputs.year, inputs.wages);

  /* --- Capital gain netting (with prior-year loss carryover) --- */
  const cg = netCapitalGains(
    inputs.shortTermCapitalGains,
    inputs.longTermCapitalGains,
    inputs.filingStatus,
    Math.max(0, inputs.priorYearCapitalLossCarryover ?? 0),
  );

  /* --- Income before Social Security taxability --- */
  const qualifiedDividends = Math.min(Math.max(0, inputs.qualifiedDividends), Math.max(0, inputs.ordinaryDividends));
  const incomeExSs =
    inputs.wages +
    inputs.interest +
    inputs.ordinaryDividends +
    cg.includedInAgi +
    // A Schedule C/F LOSS genuinely reduces AGI — do NOT clamp at 0 here.
    // (computeSeTax keeps its own clamp: there is no SE tax on a loss.)
    inputs.selfEmploymentIncome +
    inputs.rentalIncome +
    inputs.retirementIncome +
    inputs.otherIncome;

  /* --- Adjustments (above the line) --- */
  // SEP (self-employed employer contribution) and SIMPLE elective deferrals
  // both reduce AGI in this estimator model. Note: W-2 SIMPLE deferrals are
  // usually already excluded from box 1 wages — users should map these only
  // when the contributions are NOT already excluded from wages.
  const adjustments =
    Math.max(0, inputs.traditional401kContributions) +
    Math.max(0, inputs.traditionalIraContributions) +
    Math.max(0, inputs.hsaContributions) +
    Math.max(0, inputs.sepIraContributions ?? 0) +
    Math.max(0, inputs.simpleIraContributions ?? 0) +
    se.halfDeduction;

  /* --- Taxable Social Security (worksheet uses income net of adjustments) --- */
  // Per IRS Pub 915, provisional income includes tax-exempt interest (1040
  // line 2a) even though it never enters total income or AGI. It is added
  // here — and ONLY here — so muni interest can raise the taxable share of
  // Social Security benefits without itself being taxed.
  const taxableSs = computeTaxableSocialSecurity(
    inputs.socialSecurityBenefits,
    Math.max(0, incomeExSs - adjustments) + Math.max(0, inputs.taxExemptInterest ?? 0),
    inputs.filingStatus,
  );

  const totalIncome = incomeExSs + taxableSs;
  const agi = totalIncome - adjustments;

  /* --- Standard deduction --- */
  const filers65 = Math.max(0, Math.min(2, Math.floor(inputs.filersAge65Plus)));
  // §63(c)(6)(A): an MFS filer whose spouse itemizes gets a ZERO standard
  // deduction (the additional 65+ amounts are part of the standard deduction
  // and vanish with it). With a zero standard deduction, any positive
  // itemized total wins the election below — which is exactly the statutory
  // pressure that forces both spouses to itemize together.
  const standardDeduction =
    inputs.filingStatus === 'mfs' && inputs.mfsSpouseItemizes === true
      ? 0
      : p.standardDeduction + filers65 * p.additionalStdDed65;

  /* --- Itemized deduction --- */
  let saltCap = p.saltCap;
  if (p.saltPhaseDownStart !== null && agi > p.saltPhaseDownStart) {
    // OBBBA: cap reduced by 30% of MAGI over threshold, floored
    saltCap = Math.max(p.saltFloor, p.saltCap - 0.3 * (agi - p.saltPhaseDownStart));
  }
  const saltAllowed = Math.min(Math.max(0, inputs.stateLocalTaxesPaid), saltCap);
  const medicalAllowed = Math.max(0, inputs.medicalExpenses - MEDICAL_AGI_FLOOR * Math.max(0, agi));
  // §170(q) (2026+): itemized charitable allowed only above 0.5% of AGI.
  // The floored amount would carry forward under §170(d) — not tracked here.
  const charitableGross = Math.max(0, inputs.charitableDonations);
  const charitableFloorDisallowed =
    inputs.year >= CHARITY_AND_SECTION_68_FIRST_YEAR
      ? round2(Math.min(charitableGross, CHARITABLE_FLOOR_RATE * Math.max(0, agi)))
      : 0;
  const itemizedBreakdown = {
    saltAllowed: round2(saltAllowed),
    saltCap: round2(saltCap),
    mortgageInterest: round2(Math.max(0, inputs.mortgageInterest)),
    charitable: round2(charitableGross - charitableFloorDisallowed),
    charitableFloorDisallowed,
    medicalAllowed: round2(medicalAllowed),
    other: round2(Math.max(0, inputs.otherDeductions)),
  };
  const itemizedDeduction =
    itemizedBreakdown.saltAllowed +
    itemizedBreakdown.mortgageInterest +
    itemizedBreakdown.charitable +
    itemizedBreakdown.medicalAllowed +
    itemizedBreakdown.other;

  // Simplification: the itemize-vs-standard election is made before the §68
  // 2/37 limitation is applied (see header).
  const usedItemized = itemizedDeduction > standardDeduction;

  /* --- OBBBA senior deduction (2025-2028), applies on top of either --- */
  let seniorDeduction = 0;
  if (p.seniorDeductionPerFiler > 0 && filers65 > 0) {
    const gross = p.seniorDeductionPerFiler * filers65;
    const phaseOut = Math.max(0, agi - p.seniorDeductionPhaseOutStart) * 0.06;
    seniorDeduction = Math.max(0, gross - phaseOut);
  }

  /* --- OBBBA §224/§225/§163(h)(4) deductions (2025-2028) ---
   * Below the line, available whether or not itemizing (§63(b)). MAGI is
   * taken as AGI (no §911/931/933 add-backs — see header).
   */
  const magiForObbba = agi;
  const tipsDeduction = computeTipsDeduction(
    inputs.qualifiedTipIncome ?? 0, magiForObbba, inputs.filingStatus, inputs.year,
  );
  const overtimeDeduction = computeOvertimeDeduction(
    inputs.qualifiedOvertimeCompensation ?? 0, magiForObbba, inputs.filingStatus, inputs.year,
  );
  const carLoanInterestDeduction = computeCarLoanInterestDeduction(
    inputs.qualifiedCarLoanInterest ?? 0, magiForObbba, inputs.filingStatus, inputs.year,
  );

  /* --- §170(p) non-itemizer charitable deduction (2026+) ---
   * Cash gifts assumed (see header); unavailable when itemizing.
   */
  const nonItemizerCharitableDeduction =
    !usedItemized && inputs.year >= CHARITY_AND_SECTION_68_FIRST_YEAR
      ? round2(Math.min(
          charitableGross,
          isJointReturn(inputs.filingStatus)
            ? NON_ITEMIZER_CHARITABLE_CAP_JOINT
            : NON_ITEMIZER_CHARITABLE_CAP,
        ))
      : 0;

  const otherBelowLineDeductions =
    seniorDeduction + tipsDeduction + overtimeDeduction +
    carLoanInterestDeduction + nonItemizerCharitableDeduction;

  /* --- §199A qualified business income deduction (below-threshold model) --- */
  // QBI = Schedule C/F net profit less the deductible half of SE tax.
  const qualifiedBusinessIncome = Math.max(0, inputs.selfEmploymentIncome - se.halfDeduction);
  // Form 8995 line 12: net capital gain = net LTCG + qualified dividends.
  const netCapitalGainForQbi = Math.max(0, cg.preferentialLtcg) + qualifiedDividends;
  /** Taxable-income pipeline for a given standard/itemized deduction amount. */
  const taxBaseFor = (deduction: number) => {
    const beforeQbi = Math.max(0, agi - deduction - otherBelowLineDeductions);
    const qbi = computeQbiDeduction(qualifiedBusinessIncome, beforeQbi, netCapitalGainForQbi);
    return { beforeQbi, qbi, taxable: Math.max(0, beforeQbi - qbi) };
  };

  /* --- §68 2/37 overall limitation on itemized deductions (2026+) ---
   * Reduction = 2/37 × min(itemized deductions, taxable income (computed
   * WITHOUT §68, increased by those itemized deductions) − 37%-bracket
   * start). Two-pass: measure (b) uses the unreduced-itemized taxable
   * income, then the reduced deduction feeds the real pipeline.
   */
  let itemizedLimitationReduction = 0;
  if (usedItemized && inputs.year >= CHARITY_AND_SECTION_68_FIRST_YEAR) {
    const idx37 = p.brackets.findIndex(b => b.rate === 0.37);
    const bracket37Start = idx37 > 0 ? p.brackets[idx37 - 1].upTo : Infinity;
    const pass1 = taxBaseFor(itemizedDeduction);
    const incomeMeasure = Math.max(0, pass1.taxable + itemizedDeduction - bracket37Start);
    if (incomeMeasure > 0) {
      itemizedLimitationReduction = round2(
        ITEMIZED_LIMITATION_FRACTION * Math.min(itemizedDeduction, incomeMeasure),
      );
    }
  }

  const deductionTaken = usedItemized
    ? Math.max(0, itemizedDeduction - itemizedLimitationReduction)
    : standardDeduction;

  const { qbi: qbiDeduction, taxable: taxableIncome } = taxBaseFor(deductionTaken);

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

  /* --- NIIT ---
   * Form 8960 line 5a takes Schedule D's net gain INCLUDING the allowed
   * capital loss (down to -$3,000), so a loss year genuinely reduces net
   * investment income. Only the NII total floors at 0.
   */
  const netInvestmentIncome = Math.max(
    0,
    inputs.interest + inputs.ordinaryDividends + cg.includedInAgi + Math.max(0, inputs.rentalIncome),
  );
  const magi = agi; // common case: MAGI == AGI
  const niit = NIIT_RATE * Math.min(netInvestmentIncome, Math.max(0, magi - p.niitThreshold));

  /* --- Additional Medicare 0.9% ---
   * Its thresholds are NOT the NIIT thresholds: §1411 puts a qualifying
   * surviving spouse at the $250k joint threshold, while §3101(b)(2) puts QSS
   * in the "any other case" bucket at $200,000.
   */
  const medicareEarnings = Math.max(0, inputs.wages) + se.netEarningsFromSe;
  const addlMedicareThreshold = additionalMedicareThreshold(inputs.filingStatus);
  const additionalMedicareTax = ADDL_MEDICARE_RATE * Math.max(0, medicareEarnings - addlMedicareThreshold);

  /* --- Child Tax Credit (non-refundable portion only) ---
   * 2024: $2,000/qualifying child under 17 (TCJA); 2025-2026: $2,200 (OBBBA).
   * Reduced $50 per $1,000 (or fraction) of MAGI over $400k (MFJ/QSS) /
   * $200k (others). The refundable ACTC portion is not modeled — this
   * estimator only offsets income tax (not SE/NIIT/Additional Medicare).
   */
  const CTC_PER_CHILD: Record<number, number> = { 2024: 2000, 2025: 2200, 2026: 2200 };
  const qualifyingChildren = Math.max(0, Math.floor(inputs.qualifyingChildrenUnder17 ?? 0));
  let childTaxCredit = 0;
  if (qualifyingChildren > 0) {
    const ctcThreshold =
      inputs.filingStatus === 'mfj' || inputs.filingStatus === 'qss' ? 400000 : 200000;
    const excess = Math.max(0, magi - ctcThreshold);
    const reduction = Math.ceil(excess / 1000) * 50;
    const gross = qualifyingChildren * (CTC_PER_CHILD[inputs.year] ?? 2000);
    childTaxCredit = Math.min(
      Math.max(0, gross - reduction),
      ordinaryTax + capitalGainsTax, // non-refundable: cannot exceed income tax
    );
  }

  const credits = round2(childTaxCredit);
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
    capitalLossCarryoverToNextYear: round2(cg.carryoverToNextYear),
    usedItemized,
    deductionTaken: round2(deductionTaken),
    itemizedLimitationReduction,
    seniorDeduction: round2(seniorDeduction),
    tipsDeduction,
    overtimeDeduction,
    carLoanInterestDeduction,
    nonItemizerCharitableDeduction,
    qbiDeduction,
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
/** IRC §6654(i): qualifying farmers substitute 66 2/3% for 90%. */
const FARMER_CURRENT_YEAR_FACTOR = 2 / 3;

/**
 * Safe-harbor targets and the 1040-ES installment schedule.
 *
 * Standard filers: min(90% of current-year tax, 100%/110% of prior-year tax)
 * across four equal installments. Qualifying farmers (IRC §6654(i), explicit
 * `isQualifyingFarmer` flag): min(66 2/3% of current, 100% of prior — the
 * 110% high-AGI multiplier does not apply) as a SINGLE installment due
 * January 15 of the following year.
 *
 * Due dates are rolled forward past weekends and legal holidays per IRC
 * §7503, matching the compliance calendar (adjustDueDate).
 *
 * SIMPLIFICATION: the Form 2210 Schedule AI annualized-installment method
 * (uneven installments for lumpy income) is NOT implemented — installments
 * are always the even statutory 25/50/75/100% schedule.
 */
export function computeSafeHarbor(inputs: SafeHarborInputs): SafeHarborResult {
  const isQualifyingFarmer = inputs.isQualifyingFarmer === true;
  const currentYearFactor = isQualifyingFarmer ? FARMER_CURRENT_YEAR_FACTOR : 0.9;
  const ninetyPercentCurrent = round2(currentYearFactor * Math.max(0, inputs.currentYearTax));

  let priorYearSafeHarbor: number | null = null;
  let priorYearMultiplier: number | null = null;
  if (inputs.priorYearTax !== null && inputs.priorYearTax >= 0) {
    const highAgiThreshold = inputs.filingStatus === 'mfs' ? HIGH_AGI_THRESHOLD_MFS : HIGH_AGI_THRESHOLD;
    // §6654(i)(1)(D): the 110% high-AGI multiplier does not apply to farmers.
    priorYearMultiplier = isQualifyingFarmer
      ? 1.0
      : inputs.priorYearAgi !== null && inputs.priorYearAgi > highAgiThreshold ? 1.1 : 1.0;
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

  const y = inputs.year;
  // §7503: due dates falling on a weekend/legal holiday roll to the next
  // business day (same helper the compliance calendar uses).
  const due = (iso: string) => adjustDueDate(iso).dueDate;

  let quarterlySchedule: QuarterlyPayment[];
  if (isQualifyingFarmer) {
    // Single farmer installment, due Jan 15 of the following year.
    quarterlySchedule = [
      { quarter: 4, dueDate: due(`${y + 1}-01-15`), amount: estimatedPaymentsNeeded },
    ];
  } else {
    const perQuarter = round2(estimatedPaymentsNeeded / 4);
    quarterlySchedule = [
      { quarter: 1, dueDate: due(`${y}-04-15`), amount: perQuarter },
      { quarter: 2, dueDate: due(`${y}-06-15`), amount: perQuarter },
      { quarter: 3, dueDate: due(`${y}-09-15`), amount: perQuarter },
      { quarter: 4, dueDate: due(`${y + 1}-01-15`), amount: round2(estimatedPaymentsNeeded - perQuarter * 3) },
    ];
  }

  return {
    ninetyPercentCurrent,
    currentYearFactor,
    isQualifyingFarmer,
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
    taxExemptInterest: 0,
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
    sepIraContributions: 0,
    simpleIraContributions: 0,
    qualifyingChildrenUnder17: 0,
    priorYearCapitalLossCarryover: 0,
    charitableDonations: 0,
    mortgageInterest: 0,
    stateLocalTaxesPaid: 0,
    medicalExpenses: 0,
    otherDeductions: 0,
    filersAge65Plus: 0,
    mfsSpouseItemizes: false,
    qualifiedTipIncome: 0,
    qualifiedOvertimeCompensation: 0,
    qualifiedCarLoanInterest: 0,
  };
}
