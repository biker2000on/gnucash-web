/**
 * Social Security claiming optimizer — pure math, no I/O.
 *
 * Models retirement-benefit claiming for one or two spouses:
 *   - Full Retirement Age (FRA) lookup by birth year (SSA schedule).
 *   - Own-benefit adjustment vs FRA: early reduction of 5/9 of 1% per month
 *     for the first 36 months (~6.67%/yr) and 5/12 of 1% per month beyond
 *     (5%/yr); delayed retirement credits of 2/3 of 1% per month (8%/yr) up
 *     to age 70. (Reuses the factor already implemented for the FIRE
 *     estimator in src/lib/fire/ssa-params.ts.)
 *   - Spousal benefit: the lower earner can receive up to 50% of the higher
 *     earner's PIA at FRA, reduced when the spousal benefit starts before
 *     the claimer's own FRA (25/36 of 1%/month for 36 months, 5/12 of
 *     1%/month beyond). Spousal benefits earn NO delayed credits and are
 *     payable only once the higher earner has filed.
 *   - Lifetime totals: NOMINAL sums (no COLA) from each claim start to a
 *     longevity age, so strategies are compared on equal footing.
 *
 * ESTIMATES ONLY — not benefits, tax, or financial advice. Real claiming
 * decisions should use SSA statements (ssa.gov/myaccount).
 */

import {
  claimingAdjustmentFactor,
  normalRetirementAgeMonths,
  normalRetirementAgeLabel,
} from '@/lib/fire/ssa-params';

/* ------------------------------------------------------------------ */
/* Constants + FRA                                                     */
/* ------------------------------------------------------------------ */

export const MIN_CLAIM_AGE = 62;
export const MAX_CLAIM_AGE = 70;

/** Spousal early-claiming reduction: 25/36 of 1%/month for the first 36 months. */
export const SPOUSAL_REDUCTION_FIRST_36 = 25 / 36 / 100;
/** ...and 5/12 of 1%/month beyond 36 months early. */
export const SPOUSAL_REDUCTION_BEYOND_36 = 5 / 12 / 100;

/** Full Retirement Age in months for a birth year (SSA schedule). */
export function fullRetirementAgeMonths(birthYear: number): number {
  return normalRetirementAgeMonths(birthYear);
}

/** Full Retirement Age in fractional years (e.g. 66.8333 for 1959). */
export function fullRetirementAgeYears(birthYear: number): number {
  return normalRetirementAgeMonths(birthYear) / 12;
}

/** Human-readable FRA, e.g. "67" or "66 and 10 months". */
export function fullRetirementAgeLabel(birthYear: number): string {
  return normalRetirementAgeLabel(birthYear);
}

/* ------------------------------------------------------------------ */
/* Benefit adjustment factors                                          */
/* ------------------------------------------------------------------ */

/**
 * Own-benefit multiplier vs the PIA for claiming at `claimAgeYears`
 * (fractional years OK). Clamped to the 62-70 window.
 */
export function ownBenefitFactor(birthYear: number, claimAgeYears: number): number {
  return claimingAdjustmentFactor(birthYear, Math.round(claimAgeYears * 12));
}

/**
 * Spousal-benefit multiplier vs the (up to) 50%-of-PIA base for a spousal
 * benefit STARTING at `startAgeYears`. No delayed credits: the factor is 1
 * at or after the claimer's FRA.
 */
export function spousalBenefitFactor(birthYear: number, startAgeYears: number): number {
  const startMonths = Math.min(
    MAX_CLAIM_AGE * 12,
    Math.max(MIN_CLAIM_AGE * 12, Math.round(startAgeYears * 12)),
  );
  const fra = normalRetirementAgeMonths(birthYear);
  if (startMonths >= fra) return 1;
  const early = fra - startMonths;
  const reduction =
    Math.min(36, early) * SPOUSAL_REDUCTION_FIRST_36 +
    Math.max(0, early - 36) * SPOUSAL_REDUCTION_BEYOND_36;
  return 1 - reduction;
}

/* ------------------------------------------------------------------ */
/* Couple / strategy modeling                                          */
/* ------------------------------------------------------------------ */

export interface SpouseSsProfile {
  /** Monthly Primary Insurance Amount at FRA, today's dollars. */
  piaMonthly: number;
  birthYear: number;
}

export interface SpouseClaimOutcome {
  /** Claiming age used (fractional years, e.g. FRA = 66.8333). */
  claimAge: number;
  /** Own monthly benefit at that claiming age. */
  monthlyOwn: number;
  /** Monthly spousal top-up (0 when not eligible). */
  monthlySpousal: number;
  /**
   * Own age when the spousal top-up begins (needs the other spouse to have
   * filed); null when no top-up applies.
   */
  spousalStartAge: number | null;
  /** Nominal lifetime total (own + spousal) through the longevity age. */
  lifetimeTotal: number;
}

export interface ClaimingStrategyResult {
  key: 'both_62' | 'both_fra' | 'split' | 'custom';
  label: string;
  self: SpouseClaimOutcome;
  spouse: SpouseClaimOutcome | null;
  /** Sum of both spouses' lifetime totals (nominal, no COLA). */
  householdLifetime: number;
}

export interface CompareStrategiesInput {
  self: SpouseSsProfile;
  spouse?: SpouseSsProfile | null;
  /** Custom claiming ages (whole years 62-70). */
  customClaimAgeSelf: number;
  customClaimAgeSpouse?: number;
  /** Benefits are summed through this age for BOTH spouses. Default 90. */
  longevityAge?: number;
}

const round0 = (n: number) => Math.round(n);
const round2 = (n: number) => Math.round(n * 100) / 100;

function clampClaimAge(age: number): number {
  return Math.min(MAX_CLAIM_AGE, Math.max(MIN_CLAIM_AGE, age));
}

/**
 * Compute one spouse's outcome given both claim ages.
 *
 * The spousal top-up applies when 50% of the OTHER spouse's PIA exceeds the
 * claimer's own PIA. It starts once both have filed: the claimer's own claim
 * age, or their age when the other spouse files, whichever is later. The
 * early-reduction factor is taken at that start age (deemed filing after
 * 2015 rules — no restricted application).
 */
export function computeSpouseOutcome(
  own: SpouseSsProfile,
  other: SpouseSsProfile | null,
  ownClaimAge: number,
  otherClaimAge: number | null,
  longevityAge: number,
): SpouseClaimOutcome {
  const claimAge = clampClaimAge(ownClaimAge);
  const monthlyOwn = own.piaMonthly * ownBenefitFactor(own.birthYear, claimAge);

  let monthlySpousal = 0;
  let spousalStartAge: number | null = null;
  if (other && otherClaimAge !== null) {
    const excessBase = Math.max(0, other.piaMonthly / 2 - own.piaMonthly);
    if (excessBase > 0) {
      // Own age when the other spouse files: same calendar year mapping.
      const otherClaim = clampClaimAge(otherClaimAge);
      const ownAgeWhenOtherFiles = otherClaim + (other.birthYear - own.birthYear);
      const startAge = Math.max(claimAge, ownAgeWhenOtherFiles);
      if (startAge < longevityAge) {
        monthlySpousal = excessBase * spousalBenefitFactor(own.birthYear, startAge);
        spousalStartAge = startAge;
      }
    }
  }

  const ownMonths = Math.max(0, Math.round((longevityAge - claimAge) * 12));
  const spousalMonths =
    spousalStartAge !== null
      ? Math.max(0, Math.round((longevityAge - spousalStartAge) * 12))
      : 0;

  return {
    claimAge: round2(claimAge),
    monthlyOwn: round0(monthlyOwn),
    monthlySpousal: round0(monthlySpousal),
    spousalStartAge: spousalStartAge !== null ? round2(spousalStartAge) : null,
    lifetimeTotal: round0(monthlyOwn * ownMonths + monthlySpousal * spousalMonths),
  };
}

function buildStrategy(
  key: ClaimingStrategyResult['key'],
  label: string,
  input: CompareStrategiesInput,
  claimSelf: number,
  claimSpouse: number | null,
  longevityAge: number,
): ClaimingStrategyResult {
  const spouseProfile = input.spouse ?? null;
  const self = computeSpouseOutcome(
    input.self,
    spouseProfile,
    claimSelf,
    spouseProfile ? claimSpouse : null,
    longevityAge,
  );
  const spouse = spouseProfile
    ? computeSpouseOutcome(spouseProfile, input.self, claimSpouse!, claimSelf, longevityAge)
    : null;
  return {
    key,
    label,
    self,
    spouse,
    householdLifetime: round0(self.lifetimeTotal + (spouse?.lifetimeTotal ?? 0)),
  };
}

/**
 * Compare the three canonical claiming strategies plus the user's custom
 * pick. For couples, "split" delays the HIGHER-PIA spouse to 70 and claims
 * the lower earner at 62 (the usual longevity/survivor-insurance play).
 * Singles get 62 / FRA / 70 / custom.
 */
export function compareClaimingStrategies(
  input: CompareStrategiesInput,
): ClaimingStrategyResult[] {
  const longevity = input.longevityAge ?? 90;
  const hasSpouse = !!input.spouse;
  const fraSelf = fullRetirementAgeYears(input.self.birthYear);
  const fraSpouse = hasSpouse ? fullRetirementAgeYears(input.spouse!.birthYear) : null;

  const selfIsHigher = !hasSpouse || input.self.piaMonthly >= input.spouse!.piaMonthly;

  const strategies: ClaimingStrategyResult[] = [
    buildStrategy('both_62', hasSpouse ? 'Both claim at 62' : 'Claim at 62', input, 62, hasSpouse ? 62 : null, longevity),
    buildStrategy('both_fra', hasSpouse ? 'Both claim at FRA' : 'Claim at FRA', input, fraSelf, fraSpouse, longevity),
    buildStrategy(
      'split',
      hasSpouse
        ? 'Higher earner delays to 70, lower claims at 62'
        : 'Delay to 70',
      input,
      hasSpouse ? (selfIsHigher ? 70 : 62) : 70,
      hasSpouse ? (selfIsHigher ? 62 : 70) : null,
      longevity,
    ),
    buildStrategy(
      'custom',
      'Your pick',
      input,
      input.customClaimAgeSelf,
      hasSpouse ? (input.customClaimAgeSpouse ?? fraSpouse!) : null,
      longevity,
    ),
  ];

  return strategies;
}

/* ------------------------------------------------------------------ */
/* Drawdown-projection bridge                                          */
/* ------------------------------------------------------------------ */

export interface SsIncomeStream {
  /** PRIMARY filer's age when this stream starts. */
  startAge: number;
  /** Annual benefit in today's dollars. */
  annualBenefit: number;
}

/**
 * Convert a chosen claiming plan into income streams keyed by the PRIMARY
 * filer's age, for the drawdown engine. The spouse's claim age is translated
 * via the birth-year difference; spousal top-ups start when both have filed.
 */
export function buildSsIncomeStreams(
  input: CompareStrategiesInput,
  claimAgeSelf: number,
  claimAgeSpouse?: number | null,
): SsIncomeStream[] {
  const longevity = input.longevityAge ?? 90;
  const spouseProfile = input.spouse ?? null;
  const spouseClaim = spouseProfile ? clampClaimAge(claimAgeSpouse ?? 67) : null;

  const self = computeSpouseOutcome(
    input.self, spouseProfile, claimAgeSelf, spouseClaim, longevity,
  );
  const streams: SsIncomeStream[] = [];
  if (self.monthlyOwn > 0) {
    streams.push({ startAge: self.claimAge, annualBenefit: round0(self.monthlyOwn * 12) });
  }
  if (self.monthlySpousal > 0 && self.spousalStartAge !== null) {
    streams.push({
      startAge: self.spousalStartAge,
      annualBenefit: round0(self.monthlySpousal * 12),
    });
  }

  if (spouseProfile && spouseClaim !== null) {
    const spouse = computeSpouseOutcome(
      spouseProfile, input.self, spouseClaim, clampClaimAge(claimAgeSelf), longevity,
    );
    const ageOffset = spouseProfile.birthYear - input.self.birthYear;
    if (spouse.monthlyOwn > 0) {
      streams.push({
        startAge: round2(spouse.claimAge + ageOffset),
        annualBenefit: round0(spouse.monthlyOwn * 12),
      });
    }
    if (spouse.monthlySpousal > 0 && spouse.spousalStartAge !== null) {
      streams.push({
        startAge: round2(spouse.spousalStartAge + ageOffset),
        annualBenefit: round0(spouse.monthlySpousal * 12),
      });
    }
  }

  return streams.sort((a, b) => a.startAge - b.startAge);
}
