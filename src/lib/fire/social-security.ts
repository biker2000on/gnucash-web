/**
 * Social Security retirement benefit estimator.
 *
 * Pure implementation of the SSA retirement benefit computation:
 * cap annual earnings at the taxable wage base, index by AWI through the
 * age-60 year (1.0 thereafter), take the top 35 years (zero-filled),
 * AIME = floor(sum / 420), PIA via the 90/32/15% bend-point formula for the
 * eligibility year (rounded down to a dime), COLAs from eligibility to the
 * present, then the early/delayed claiming adjustment vs the worker's NRA
 * (final benefit truncated to the dollar, per SSA rounding rules).
 *
 * With the default 0% future wage growth, years beyond the published SSA
 * tables are frozen at today's values, so results come out in today's
 * dollars — exactly what the FIRE Monte Carlo engine expects.
 */

import {
  awiForYear,
  bendPointsForYear,
  claimingAdjustmentFactor,
  COLA_SERIES,
  LATEST_AWI_YEAR,
  LATEST_COLA_YEAR,
  normalRetirementAgeLabel,
  normalRetirementAgeMonths,
  PIA_FACTORS,
  wageBaseForYear,
} from './ssa-params';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface EarningsRecord {
  year: number;
  /** Gross covered earnings for the calendar year, in nominal dollars */
  earnings: number;
}

export interface SocialSecurityEstimateInput {
  earnings: EarningsRecord[];
  birthYear: number;
  /** Claiming age in whole years, clamped to 62-70 */
  claimingAge: number;
  /**
   * Assume the latest year's earnings level continues each year until the
   * year before claiming (default true — the user is likely mid-career).
   */
  projectFutureEarnings?: boolean;
  /**
   * Wage growth used to extrapolate AWI/wage base/bend points beyond the
   * published tables. Default 0 keeps the estimate in today's dollars
   * (recommended); a positive rate produces nominal future dollars.
   */
  futureWageGrowthPct?: number;
}

export interface Top35Row {
  year: number;
  /** Raw earnings before any cap */
  raw: number;
  /** Earnings after the taxable wage base cap */
  capped: number;
  /** AWI index factor applied (1.0 for the age-60 year and later) */
  indexFactor: number;
  /** capped x indexFactor — the value that enters the AIME */
  indexed: number;
  /** True when this year was projected rather than from actual history */
  projected: boolean;
}

export interface SocialSecurityDiagnostics {
  /** Year the worker turns 62 */
  eligibilityYear: number;
  /** Year the worker turns 60 — earnings after this are not indexed */
  indexingYear: number;
  /** Actual (non-projected) years with positive earnings */
  yearsWithEarnings: number;
  /** Years filled in by the continued-earnings projection */
  projectedYears: number;
  /** Zero years among the 35 computation years */
  zeroYearsInTop35: number;
  /** Average Indexed Monthly Earnings */
  aime: number;
  /** PIA at eligibility, before COLAs */
  piaAtEligibility: number;
  /** PIA after COLAs through the latest published COLA (today's $) */
  pia: number;
  /** Bend points used (eligibility-year values) */
  bendPoints: [number, number];
  nraMonths: number;
  nraLabel: string;
  /** Multiplier applied to the PIA for the chosen claiming age */
  claimingAdjustment: number;
  /** The 35 computation years, sorted by indexed earnings descending */
  top35: Top35Row[];
  /** True when any AWI/bend-point/wage-base value was extrapolated */
  usedEstimatedParams: boolean;
}

export interface SocialSecurityEstimate {
  /** Monthly benefit at the chosen claiming age, today's $ (growth 0%) */
  monthlyBenefit: number;
  annualBenefit: number;
  diagnostics: SocialSecurityDiagnostics;
}

/* ------------------------------------------------------------------ */
/* Building blocks (exported for tests)                                */
/* ------------------------------------------------------------------ */

/** AIME = floor(sum of top-35 indexed earnings / 420 months). */
export function computeAIME(indexedEarnings: number[]): number {
  const top35 = [...indexedEarnings].sort((a, b) => b - a).slice(0, 35);
  const sum = top35.reduce((s, v) => s + v, 0);
  return Math.floor(sum / 420);
}

/** Round down to the next lower multiple of $0.10 (SSA PIA rounding). */
export function roundDownToDime(value: number): number {
  // Guard against float artifacts like 1157.4000000000001 / 3225.5599999...
  return Math.floor(Math.round(value * 1000) / 100) / 10;
}

/**
 * PIA from AIME via the bend-point formula for the eligibility year:
 * 90% of AIME up to the first bend, 32% to the second, 15% above —
 * rounded down to a dime.
 */
export function computePIA(aime: number, bendPoints: readonly [number, number]): number {
  const [b1, b2] = bendPoints;
  const pia =
    PIA_FACTORS[0] * Math.min(aime, b1) +
    PIA_FACTORS[1] * Math.max(0, Math.min(aime, b2) - b1) +
    PIA_FACTORS[2] * Math.max(0, aime - b2);
  return roundDownToDime(pia);
}

/** Apply COLAs from the eligibility year through the latest published COLA. */
export function applyColas(pia: number, eligibilityYear: number): number {
  let adjusted = pia;
  for (let y = eligibilityYear; y <= LATEST_COLA_YEAR; y++) {
    const cola = COLA_SERIES[y];
    if (cola === undefined) continue;
    adjusted = roundDownToDime(adjusted * (1 + cola / 100));
  }
  return adjusted;
}

/* ------------------------------------------------------------------ */
/* Main estimator                                                       */
/* ------------------------------------------------------------------ */

export function estimateSocialSecurityBenefit(
  input: SocialSecurityEstimateInput,
): SocialSecurityEstimate {
  const growth = input.futureWageGrowthPct ?? 0;
  const project = input.projectFutureEarnings ?? true;
  const birthYear = Math.round(input.birthYear);
  const claimingAge = Math.min(70, Math.max(62, Math.round(input.claimingAge)));

  const eligibilityYear = birthYear + 62;
  const indexingYear = birthYear + 60;
  const claimingYear = birthYear + claimingAge;

  // Deduplicate by year (last wins) and keep positive earnings only.
  const byYear = new Map<number, number>();
  for (const rec of input.earnings) {
    if (!Number.isFinite(rec.earnings) || rec.earnings <= 0) continue;
    if (!Number.isInteger(rec.year)) continue;
    byYear.set(rec.year, rec.earnings);
  }
  const actualYears = [...byYear.keys()].sort((a, b) => a - b);
  const yearsWithEarnings = actualYears.length;

  const indexFactor = (year: number): number =>
    year >= indexingYear ? 1 : awiForYear(indexingYear, growth) / awiForYear(year, growth);

  const rows: Top35Row[] = [];
  let usedEstimatedParams = indexingYear > LATEST_AWI_YEAR;

  for (const year of actualYears) {
    const raw = byYear.get(year)!;
    if (year > LATEST_AWI_YEAR) usedEstimatedParams = true;
    const capped = Math.min(raw, wageBaseForYear(year, growth));
    const factor = indexFactor(year);
    rows.push({
      year,
      raw,
      capped,
      indexFactor: factor,
      indexed: capped * factor,
      projected: false,
    });
  }

  // Projection: continue the latest actual year's earnings level through the
  // year before claiming. Projected years use that year's (possibly
  // extrapolated) wage base; with 0% growth their indexed value equals
  // today's earnings level, i.e. constant real earnings.
  let projectedYears = 0;
  if (project && yearsWithEarnings > 0) {
    const lastYear = actualYears[actualYears.length - 1];
    const lastEarnings = byYear.get(lastYear)!;
    for (let year = lastYear + 1; year < claimingYear; year++) {
      usedEstimatedParams = usedEstimatedParams || year > LATEST_AWI_YEAR;
      // Grow nominal earnings with the wage-growth assumption so the
      // projection stays flat in real terms under any growth rate.
      const nominal = lastEarnings * Math.pow(1 + growth / 100, year - lastYear);
      const capped = Math.min(nominal, wageBaseForYear(year, growth));
      const factor = indexFactor(year);
      rows.push({
        year,
        raw: nominal,
        capped,
        indexFactor: factor,
        indexed: capped * factor,
        projected: true,
      });
      projectedYears++;
    }
  }

  const sorted = [...rows].sort((a, b) => b.indexed - a.indexed);
  const top35 = sorted.slice(0, 35);
  const zeroYearsInTop35 = Math.max(0, 35 - top35.length);

  const aime = computeAIME(rows.map(r => r.indexed));
  const bendPoints = bendPointsForYear(eligibilityYear, growth);
  if (eligibilityYear > LATEST_AWI_YEAR + 2) usedEstimatedParams = true;
  const piaAtEligibility = computePIA(aime, bendPoints);
  // COLAs only accrue once eligible; future eligibility years get none
  // (today's-dollars freeze).
  const pia = eligibilityYear <= LATEST_COLA_YEAR
    ? applyColas(piaAtEligibility, eligibilityYear)
    : piaAtEligibility;

  const nraMonths = normalRetirementAgeMonths(birthYear);
  const claimingAdjustment = claimingAdjustmentFactor(birthYear, claimingAge * 12);

  // Final monthly benefit is truncated to the next lower dollar.
  const monthlyBenefit = Math.floor(pia * claimingAdjustment + 1e-9);

  return {
    monthlyBenefit,
    annualBenefit: monthlyBenefit * 12,
    diagnostics: {
      eligibilityYear,
      indexingYear,
      yearsWithEarnings,
      projectedYears,
      zeroYearsInTop35,
      aime,
      piaAtEligibility,
      pia,
      bendPoints,
      nraMonths,
      nraLabel: normalRetirementAgeLabel(birthYear),
      claimingAdjustment,
      top35,
      usedEstimatedParams,
    },
  };
}
