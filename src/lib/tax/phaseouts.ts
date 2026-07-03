/**
 * MAGI-based IRA phase-out schedules — pure functions, no I/O.
 *
 * Implements the Traditional IRA deduction phase-out (IRC §219(g)) and the
 * Roth IRA contribution phase-out (IRC §408A(c)(3)) for tax years 2024-2026.
 *
 * Verified figures:
 * - 2024: Notice 2023-75
 *   - Trad IRA (covered):    single/hoh 77,000–87,000; mfj 123,000–143,000; mfs 0–10,000
 *   - Trad IRA (spouse-covered, mfj): 230,000–240,000
 *   - Roth: single/hoh 146,000–161,000; mfj/qss 230,000–240,000; mfs 0–10,000
 * - 2025: Notice 2024-80
 *   - Trad IRA (covered):    single/hoh 79,000–89,000; mfj 126,000–146,000; mfs 0–10,000
 *   - Trad IRA (spouse-covered, mfj): 236,000–246,000
 *   - Roth: single/hoh 150,000–165,000; mfj/qss 236,000–246,000; mfs 0–10,000
 * - 2026: Notice 2025-67 (IRA/retirement COLAs companion to Rev. Proc. 2025-32)
 *   - Trad IRA (covered):    single/hoh 81,000–91,000; mfj 129,000–149,000; mfs 0–10,000
 *   - Trad IRA (spouse-covered, mfj): 242,000–252,000
 *   - Roth: single/hoh 153,000–168,000; mfj/qss 242,000–252,000; mfs 0–10,000
 *
 * Rounding follows IRS Pub 590-A worksheets: the reduced limit is rounded UP
 * to the nearest $10, with a $200 minimum whenever the taxpayer is inside the
 * phase-out range but not fully phased out.
 *
 * SIMPLIFICATION: qss (Qualifying Surviving Spouse) uses MFJ ranges for BOTH
 * schedules. This matches IRS treatment for the Roth phase-out; for the
 * active-participant traditional IRA deduction the IRS technically lists QSS
 * with single filers, but we intentionally use MFJ ranges here to keep the
 * model consistent with the rest of the engine (which treats qss as mfj).
 *
 * ESTIMATES ONLY — not tax advice.
 */

import type { FilingStatus, TaxYear } from './types';

/* ------------------------------------------------------------------ */
/* Schedule tables (exported so the UI can display the ranges)         */
/* ------------------------------------------------------------------ */

export interface PhaseOutRange {
  /** MAGI at or below which the full limit applies */
  start: number;
  /** MAGI at or above which the limit is fully phased out */
  end: number;
}

type RangeByStatus = Record<FilingStatus, PhaseOutRange>;

function ranges(
  singleHoh: [number, number],
  mfjQss: [number, number],
  mfs: [number, number],
): RangeByStatus {
  return {
    single: { start: singleHoh[0], end: singleHoh[1] },
    hoh: { start: singleHoh[0], end: singleHoh[1] },
    mfj: { start: mfjQss[0], end: mfjQss[1] },
    qss: { start: mfjQss[0], end: mfjQss[1] }, // simplification: qss = mfj (see header)
    mfs: { start: mfs[0], end: mfs[1] },
  };
}

/**
 * Traditional IRA deduction phase-out when the CONTRIBUTOR is an active
 * participant in an employer plan (401k/403b/etc.).
 */
export const IRA_DEDUCTION_PHASEOUT: Record<TaxYear, RangeByStatus> = {
  2024: ranges([77_000, 87_000], [123_000, 143_000], [0, 10_000]),
  2025: ranges([79_000, 89_000], [126_000, 146_000], [0, 10_000]),
  2026: ranges([81_000, 91_000], [129_000, 149_000], [0, 10_000]),
};

/**
 * Traditional IRA deduction phase-out when the contributor is NOT covered
 * but their SPOUSE is (married filing jointly). MFS with a covered spouse
 * always uses the 0–10,000 range (Pub 590-A Table 1-3).
 */
export const IRA_SPOUSE_COVERED_PHASEOUT: Record<TaxYear, PhaseOutRange> = {
  2024: { start: 230_000, end: 240_000 },
  2025: { start: 236_000, end: 246_000 },
  2026: { start: 242_000, end: 252_000 },
};

/** Roth IRA contribution phase-out (applies regardless of employer coverage). */
export const ROTH_IRA_PHASEOUT: Record<TaxYear, RangeByStatus> = {
  2024: ranges([146_000, 161_000], [230_000, 240_000], [0, 10_000]),
  2025: ranges([150_000, 165_000], [236_000, 246_000], [0, 10_000]),
  2026: ranges([153_000, 168_000], [242_000, 252_000], [0, 10_000]),
};

/* ------------------------------------------------------------------ */
/* Phase-out math                                                      */
/* ------------------------------------------------------------------ */

export type PhaseOutStatus = 'full' | 'partial' | 'none';

export interface PhaseOutResult {
  /** Allowed (deductible / contributable) amount after the phase-out */
  deductibleLimit: number;
  /** null when no phase-out applies (e.g. not covered by any plan) */
  phaseOutStart: number | null;
  phaseOutEnd: number | null;
  status: PhaseOutStatus;
}

/**
 * Linear phase-out per IRS Pub 590-A worksheets:
 *   reduced = limit × (end − magi) / (end − start)
 * rounded UP to the nearest $10, with a $200 minimum when inside the range.
 */
function applyPhaseOut(iraLimit: number, magi: number, range: PhaseOutRange): PhaseOutResult {
  const base = { phaseOutStart: range.start, phaseOutEnd: range.end };
  if (magi <= range.start) {
    return { ...base, deductibleLimit: iraLimit, status: 'full' };
  }
  if (magi >= range.end) {
    return { ...base, deductibleLimit: 0, status: 'none' };
  }
  const raw = iraLimit * (range.end - magi) / (range.end - range.start);
  const roundedUp = Math.ceil(raw / 10) * 10;
  const deductibleLimit = Math.min(iraLimit, Math.max(200, roundedUp));
  return { ...base, deductibleLimit, status: 'partial' };
}

/* ------------------------------------------------------------------ */
/* Traditional IRA deduction                                           */
/* ------------------------------------------------------------------ */

export interface IraDeductionInputs {
  year: TaxYear;
  filingStatus: FilingStatus;
  /** Modified AGI (for this estimator, AGI is a reasonable proxy) */
  magi: number;
  /** Contributor is an active participant in an employer plan */
  coveredByEmployerPlan: boolean;
  /** Spouse is an active participant in an employer plan */
  spouseCoveredByEmployerPlan: boolean;
  /** The taxpayer's IRA contribution limit (base + catch-up, e.g. 7,000/8,000) */
  iraLimit: number;
}

/**
 * How much of a traditional IRA contribution is deductible given MAGI and
 * employer-plan coverage (IRC §219(g), IRS Pub 590-A):
 *
 * - Contributor covered → covered-participant ranges (IRA_DEDUCTION_PHASEOUT).
 * - Contributor NOT covered, spouse covered:
 *   - mfj/qss → spouse-covered range (IRA_SPOUSE_COVERED_PHASEOUT).
 *   - mfs → 0–10,000 range (Pub 590-A Table 1-3).
 * - Neither covered → fully deductible at any MAGI (no phase-out).
 */
export function computeIraDeductionLimit(inputs: IraDeductionInputs): PhaseOutResult {
  const { year, filingStatus, magi, iraLimit } = inputs;

  if (inputs.coveredByEmployerPlan) {
    return applyPhaseOut(iraLimit, magi, IRA_DEDUCTION_PHASEOUT[year][filingStatus]);
  }

  if (inputs.spouseCoveredByEmployerPlan) {
    if (filingStatus === 'mfj' || filingStatus === 'qss') {
      return applyPhaseOut(iraLimit, magi, IRA_SPOUSE_COVERED_PHASEOUT[year]);
    }
    if (filingStatus === 'mfs') {
      return applyPhaseOut(iraLimit, magi, { start: 0, end: 10_000 });
    }
    // single/hoh: a "spouse" flag is inconsistent with the status — treat as
    // not covered (fully deductible) rather than guessing.
  }

  // Neither spouse covered by an employer plan → fully deductible.
  return { deductibleLimit: iraLimit, phaseOutStart: null, phaseOutEnd: null, status: 'full' };
}

/* ------------------------------------------------------------------ */
/* Roth IRA contribution                                               */
/* ------------------------------------------------------------------ */

export interface RothIraContributionInputs {
  year: TaxYear;
  filingStatus: FilingStatus;
  magi: number;
  /** The taxpayer's IRA contribution limit (base + catch-up) */
  iraLimit: number;
}

/**
 * Maximum Roth IRA contribution allowed given MAGI (IRC §408A(c)(3),
 * IRS Pub 590-A). Same linear phase-out, $10 round-up, $200 minimum.
 */
export function computeRothIraContributionLimit(inputs: RothIraContributionInputs): PhaseOutResult {
  const { year, filingStatus, magi, iraLimit } = inputs;
  return applyPhaseOut(iraLimit, magi, ROTH_IRA_PHASEOUT[year][filingStatus]);
}
