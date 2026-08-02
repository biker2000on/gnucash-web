/**
 * Retirement Income Sequencing & Social Security claiming optimizer.
 *
 * Pure, synchronous engine. Reuses the repo's existing engines instead of
 * reimplementing them:
 * - SSA claiming math (NRA, early reduction, delayed credits) from
 *   `@/lib/fire/ssa-params`, and PIA estimation from earnings via
 *   `@/lib/fire/social-security`.
 * - Year-by-year spend-down, withdrawal sequencing, RMDs, and federal tax via
 *   `runDrawdown` from `@/lib/drawdown/engine`.
 * - SECURE 2.0 RMD start ages and Uniform Lifetime Table via `@/lib/drawdown/rmd`.
 * - 2026 IRMAA tiers via `@/lib/drawdown/irmaa`.
 *
 * ESTIMATES ONLY — not tax, Social Security, or investment advice.
 */

import {
  claimingAdjustmentFactor,
  normalRetirementAgeLabel,
  normalRetirementAgeMonths,
} from '@/lib/fire/ssa-params';
import { estimateSocialSecurityBenefit } from '@/lib/fire/social-security';
import { runDrawdown } from '@/lib/drawdown/engine';
import { DEFAULT_SEQUENCING, type Bucket } from '@/lib/drawdown/types';
import { computeRmd, rmdStartAge } from '@/lib/drawdown/rmd';
import { IRMAA_TIERS_2026, PART_B_STANDARD_MONTHLY_2026 } from '@/lib/drawdown/irmaa';
import type { FilingStatus } from '@/lib/tax/types';
import type { RetirementIncomeProfile, RetirementPerson } from './types';

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Claiming recommendation must beat the plan by this much lifetime money to raise an action. */
export const CLAIMING_DELTA_ACTION_THRESHOLD = 10_000;
/** Sequencing ending-value improvement below this raises no action. */
export const SEQUENCING_DELTA_ACTION_THRESHOLD = 5_000;
/** MAGI within this many dollars below the next IRMAA threshold flags a cliff. */
export const IRMAA_CLIFF_WINDOW = 10_000;
/** Age Social Security benefits first become claimable. */
export const EARLIEST_CLAIM_AGE = 62;
/** Age delayed retirement credits stop accruing. */
export const LATEST_CLAIM_AGE = 70;
/** Assumed first year of covered earnings when estimating a PIA from current earnings. */
export const ASSUMED_CAREER_START_AGE = 22;

export type PiaSource = 'entered' | 'estimated' | 'missing';

export interface ClaimingOption {
  /** Claiming age in months (FRA is not always a whole year). */
  claimAgeMonths: number;
  /** Claiming age in years (may be fractional for FRA). */
  claimAgeYears: number;
  label: string;
  /** Multiplier applied to the PIA for this claiming age. */
  adjustment: number;
  monthlyBenefit: number;
  annualBenefit: number;
  /** Cumulative benefits from claim through the horizon-age year, with COLA. */
  lifetimeTotal: number;
}

export interface ClaimingBreakeven {
  earlierLabel: string;
  laterLabel: string;
  /** Age (1 decimal) where the later claim's cumulative total overtakes the earlier one, or null within the horizon. */
  breakevenAge: number | null;
}

export interface PersonClaimingAnalysis {
  personId: string;
  name: string;
  birthYear: number;
  currentAge: number;
  piaSource: PiaSource;
  /** Monthly PIA at full retirement age used for all options. */
  pia: number;
  fraMonths: number;
  fraLabel: string;
  options: ClaimingOption[];
  breakevens: ClaimingBreakeven[];
  plannedClaimAge: number;
  plannedMonthlyBenefit: number;
  plannedAnnualBenefit: number;
  plannedLifetimeTotal: number;
  /** Whole-year claim age with the highest lifetime total among the compared options. */
  recommendedClaimAge: number;
  recommendedLabel: string;
  recommendedMonthlyBenefit: number;
  recommendedLifetimeTotal: number;
  /** recommended lifetime − planned lifetime (>= 0). */
  lifetimeDelta: number;
}

export interface SequencingVariantResult {
  id: 'taxable_first' | 'traditional_first';
  label: string;
  order: readonly Bucket[];
  endingTotal: number;
  lifetimeTax: number;
  depletionAge: number | null;
  firstYearAgi: number;
}

export interface SequencingAnalysis {
  variants: SequencingVariantResult[];
  bestVariantId: SequencingVariantResult['id'];
  /** The user's preference when it maps to a simulable ordering, else null. */
  preferredVariantId: SequencingVariantResult['id'] | null;
  preferenceSupported: boolean;
  /** best ending value − preferred ending value (0 when preference wins or is unsupported). */
  endingValueDelta: number;
}

export interface IrmaaTierRow {
  tier: number;
  threshold: number;
  monthlySurcharge: number;
  annualSurcharge: number;
}

export interface IrmaaAnalysis {
  /** First model year the MAGI proxy applies to. */
  year: number;
  /** First-year federal AGI from the chosen sequencing variant (MAGI proxy). */
  magi: number;
  /** 0 when below every threshold, else the 1-based tier the MAGI lands in. */
  tier: number;
  tiers: IrmaaTierRow[];
  /** Dollars of MAGI room below the next threshold, or null above the top tier. */
  headroomToNextTier: number | null;
  nextTierThreshold: number | null;
  withinCliff: boolean;
  /** Extra annual surcharge per enrollee if MAGI crosses into the next tier. */
  surchargeDeltaAnnual: number;
}

export interface PersonRmdContext {
  personId: string;
  name: string;
  rmdStartAge: number;
  firstRmdYear: number;
  yearsUntilFirstRmd: number;
  /** First-year RMD from the household traditional balance grown at the real return. */
  estimatedFirstRmd: number;
}

const SEQUENCING_ORDERS: Record<SequencingVariantResult['id'], { label: string; order: readonly Bucket[] }> = {
  taxable_first: { label: 'Taxable first (default)', order: DEFAULT_SEQUENCING },
  traditional_first: { label: 'Traditional first', order: ['traditional', 'taxable', 'roth', 'hsa'] },
};

function filingStatusFor(profile: RetirementIncomeProfile): FilingStatus {
  return profile.settings.filingStatus === 'married_joint' ? 'mfj' : 'single';
}

/** Monthly benefit for a claiming age in months, 2dp, using the repo SSA adjustment factors. */
function monthlyAt(pia: number, birthYear: number, claimAgeMonths: number): number {
  return round2(pia * claimingAdjustmentFactor(birthYear, claimAgeMonths));
}

/**
 * Cumulative benefits by month from EARLIEST_CLAIM_AGE through the end of the
 * horizon-age year. COLA compounds from age 62 for every option (COLAs accrue
 * on the PIA from eligibility whether or not benefits have started), keeping
 * the options comparable.
 */
function cumulativeByMonth(
  monthly: number,
  claimAgeMonths: number,
  horizonAge: number,
  colaPct: number,
): number[] {
  const startMonth = EARLIEST_CLAIM_AGE * 12;
  const endMonth = (horizonAge + 1) * 12; // exclusive
  const totals: number[] = [];
  let cumulative = 0;
  for (let month = startMonth; month < endMonth; month++) {
    if (month >= claimAgeMonths) {
      const age = Math.floor(month / 12);
      cumulative += monthly * Math.pow(1 + colaPct / 100, age - EARLIEST_CLAIM_AGE);
    }
    totals.push(cumulative);
  }
  return totals;
}

function resolvePia(person: RetirementPerson, currentYear: number): { pia: number; source: PiaSource } {
  if (person.pia > 0) return { pia: person.pia, source: 'entered' };
  const earnings = person.annualEarnings ?? 0;
  if (earnings <= 0) return { pia: 0, source: 'missing' };
  const firstYear = person.birthYear + ASSUMED_CAREER_START_AGE;
  const lastYear = Math.max(firstYear, currentYear - 1);
  const records = [];
  for (let year = firstYear; year <= lastYear; year++) {
    records.push({ year, earnings });
  }
  const estimate = estimateSocialSecurityBenefit({
    earnings: records,
    birthYear: person.birthYear,
    claimingAge: person.plannedClaimAge,
    projectFutureEarnings: true,
    futureWageGrowthPct: 0,
  });
  return { pia: estimate.diagnostics.pia, source: 'estimated' };
}

function analyzePerson(
  person: RetirementPerson,
  currentYear: number,
  horizonAge: number,
  colaPct: number,
): PersonClaimingAnalysis {
  const { pia, source } = resolvePia(person, currentYear);
  const fraMonths = normalRetirementAgeMonths(person.birthYear);
  const fraLabel = normalRetirementAgeLabel(person.birthYear);
  const candidates: Array<{ months: number; label: string }> = [
    { months: EARLIEST_CLAIM_AGE * 12, label: `${EARLIEST_CLAIM_AGE}` },
    { months: fraMonths, label: `FRA (${fraLabel})` },
    { months: LATEST_CLAIM_AGE * 12, label: `${LATEST_CLAIM_AGE}` },
  ];

  const options: ClaimingOption[] = candidates.map(candidate => {
    const adjustment = claimingAdjustmentFactor(person.birthYear, candidate.months);
    const monthly = monthlyAt(pia, person.birthYear, candidate.months);
    const cumulative = cumulativeByMonth(monthly, candidate.months, horizonAge, colaPct);
    return {
      claimAgeMonths: candidate.months,
      claimAgeYears: round2(candidate.months / 12),
      label: candidate.label,
      adjustment: Math.round(adjustment * 10_000) / 10_000,
      monthlyBenefit: monthly,
      annualBenefit: round2(monthly * 12),
      lifetimeTotal: round2(cumulative[cumulative.length - 1] ?? 0),
    };
  });

  const breakevens: ClaimingBreakeven[] = [];
  for (let a = 0; a < options.length; a++) {
    for (let b = a + 1; b < options.length; b++) {
      const earlier = options[a];
      const later = options[b];
      if (earlier.claimAgeMonths === later.claimAgeMonths) continue;
      const earlierCumulative = cumulativeByMonth(earlier.monthlyBenefit, earlier.claimAgeMonths, horizonAge, colaPct);
      const laterCumulative = cumulativeByMonth(later.monthlyBenefit, later.claimAgeMonths, horizonAge, colaPct);
      let breakevenAge: number | null = null;
      for (let index = 0; index < laterCumulative.length; index++) {
        if (laterCumulative[index] > 0 && laterCumulative[index] >= earlierCumulative[index]) {
          breakevenAge = Math.round(((EARLIEST_CLAIM_AGE * 12 + index) / 12) * 10) / 10;
          break;
        }
      }
      breakevens.push({ earlierLabel: earlier.label, laterLabel: later.label, breakevenAge });
    }
  }

  // Recommendation: the compared option with the highest lifetime total,
  // expressed as a whole-year claim age (FRA rounds to the nearest year).
  const recommended = options.reduce((best, option) =>
    option.lifetimeTotal > best.lifetimeTotal ? option : best, options[0]);

  const plannedMonths = Math.min(LATEST_CLAIM_AGE, Math.max(EARLIEST_CLAIM_AGE, person.plannedClaimAge)) * 12;
  const plannedMonthly = monthlyAt(pia, person.birthYear, plannedMonths);
  const plannedCumulative = cumulativeByMonth(plannedMonthly, plannedMonths, horizonAge, colaPct);
  const plannedLifetime = round2(plannedCumulative[plannedCumulative.length - 1] ?? 0);

  return {
    personId: person.id,
    name: person.name,
    birthYear: person.birthYear,
    currentAge: currentYear - person.birthYear,
    piaSource: source,
    pia: round2(pia),
    fraMonths,
    fraLabel,
    options,
    breakevens,
    plannedClaimAge: person.plannedClaimAge,
    plannedMonthlyBenefit: plannedMonthly,
    plannedAnnualBenefit: round2(plannedMonthly * 12),
    plannedLifetimeTotal: plannedLifetime,
    recommendedClaimAge: Math.round(recommended.claimAgeMonths / 12),
    recommendedLabel: recommended.label,
    recommendedMonthlyBenefit: recommended.monthlyBenefit,
    recommendedLifetimeTotal: recommended.lifetimeTotal,
    lifetimeDelta: round2(Math.max(0, recommended.lifetimeTotal - plannedLifetime)),
  };
}

function analyzeSequencing(
  profile: RetirementIncomeProfile,
  people: PersonClaimingAnalysis[],
  currentYear: number,
): SequencingAnalysis | null {
  const primary = profile.people[0];
  if (!primary) return null;
  const { settings, balances } = profile;
  const currentAge = currentYear - primary.birthYear;
  if (currentAge < 0 || currentAge > settings.horizonAge) return null;

  const spouse = profile.people[1] ?? null;
  const nominalReturn = Math.round(((1 + settings.realReturnPct / 100) * (1 + settings.colaPct / 100) - 1) * 1e6) / 1e6;
  const streams = people
    .filter(person => person.plannedAnnualBenefit > 0)
    .map(person => ({
      // Primary filer's age when this person reaches their planned claim age.
      startAge: person.birthYear + person.plannedClaimAge - primary.birthYear,
      annualBenefit: person.plannedAnnualBenefit,
    }));

  const variants = (Object.keys(SEQUENCING_ORDERS) as Array<SequencingVariantResult['id']>).map(id => {
    const definition = SEQUENCING_ORDERS[id];
    const result = runDrawdown({
      currentAge,
      spouseAge: spouse ? currentYear - spouse.birthYear : null,
      retirementAge: currentAge,
      endAge: settings.horizonAge,
      startYear: currentYear,
      filingStatus: filingStatusFor(profile),
      state: 'OTHER',
      stateFlatRateOverride: 0,
      startingBalances: { ...balances },
      nominalReturns: {
        taxable: nominalReturn,
        traditional: nominalReturn,
        roth: nominalReturn,
        hsa: nominalReturn,
      },
      annualSpending: settings.annualSpending,
      inflationRate: settings.colaPct / 100,
      socialSecurityStreams: streams,
      sequencing: definition.order,
    });
    return {
      id,
      label: definition.label,
      order: definition.order,
      endingTotal: result.summary.endingTotal,
      lifetimeTax: result.summary.lifetimeTax,
      depletionAge: result.summary.depletionAge,
      firstYearAgi: result.rows[0]?.agi ?? 0,
    };
  });

  const best = variants.reduce((winner, variant) =>
    variant.endingTotal > winner.endingTotal
    || (variant.endingTotal === winner.endingTotal && variant.lifetimeTax < winner.lifetimeTax)
      ? variant
      : winner, variants[0]);
  const preferenceSupported = settings.sequencingPreference !== 'proportional';
  const preferredVariantId = preferenceSupported
    ? settings.sequencingPreference as SequencingVariantResult['id']
    : null;
  const preferred = variants.find(variant => variant.id === preferredVariantId) ?? null;

  return {
    variants,
    bestVariantId: best.id,
    preferredVariantId,
    preferenceSupported,
    endingValueDelta: preferred ? round2(Math.max(0, best.endingTotal - preferred.endingTotal)) : 0,
  };
}

function irmaaTiersFor(joint: boolean): IrmaaTierRow[] {
  return IRMAA_TIERS_2026.map((definition, index) => {
    const monthly = PART_B_STANDARD_MONTHLY_2026 * (definition.partBMultiplier - 1) + definition.partDMonthly;
    return {
      tier: index + 1,
      threshold: joint ? definition.mfjAbove : definition.singleAbove,
      monthlySurcharge: round2(monthly),
      annualSurcharge: round2(monthly * 12),
    };
  });
}

function analyzeIrmaa(
  profile: RetirementIncomeProfile,
  sequencing: SequencingAnalysis | null,
  currentYear: number,
): IrmaaAnalysis | null {
  if (!sequencing) return null;
  const chosenId = sequencing.preferredVariantId ?? 'taxable_first';
  const chosen = sequencing.variants.find(variant => variant.id === chosenId) ?? sequencing.variants[0];
  const joint = profile.settings.filingStatus === 'married_joint';
  const tiers = irmaaTiersFor(joint);
  const magi = round2(chosen.firstYearAgi);
  const tier = tiers.filter(row => magi > row.threshold).length;
  const next = tiers[tier] ?? null;
  const headroom = next ? round2(next.threshold - magi) : null;
  const currentSurcharge = tier > 0 ? tiers[tier - 1].annualSurcharge : 0;
  const surchargeDelta = next ? round2(next.annualSurcharge - currentSurcharge) : 0;
  return {
    year: currentYear,
    magi,
    tier,
    tiers,
    headroomToNextTier: headroom,
    nextTierThreshold: next?.threshold ?? null,
    withinCliff: headroom != null && headroom <= IRMAA_CLIFF_WINDOW,
    surchargeDeltaAnnual: surchargeDelta,
  };
}

export function analyzeRetirementIncome(profile: RetirementIncomeProfile, asOf = new Date()) {
  const { settings } = profile;
  const asOfDate = asOf.toISOString().slice(0, 10);
  const currentYear = asOf.getUTCFullYear();

  const people = profile.people.slice(0, 2).map(person =>
    analyzePerson(person, currentYear, settings.horizonAge, settings.colaPct));

  const sequencing = analyzeSequencing(profile, people, currentYear);
  const irmaa = analyzeIrmaa(profile, sequencing, currentYear);

  const rmd: PersonRmdContext[] = profile.people.slice(0, 2).map(person => {
    const startAge = rmdStartAge(person.birthYear);
    const firstRmdYear = person.birthYear + startAge;
    const yearsUntil = firstRmdYear - currentYear;
    const grown = profile.balances.traditional * Math.pow(1 + settings.realReturnPct / 100, Math.max(0, yearsUntil));
    return {
      personId: person.id,
      name: person.name,
      rmdStartAge: startAge,
      firstRmdYear,
      yearsUntilFirstRmd: yearsUntil,
      estimatedFirstRmd: round2(computeRmd(startAge, person.birthYear, grown)),
    };
  });

  const assumptions = [
    'Birthdays are approximated as mid-year; ages are calendar-year differences from the birth year.',
    'COLAs compound on every claiming option from age 62, matching SSA COLA accrual on the PIA whether or not benefits have started.',
    'The claiming comparison ranks cumulative benefits through the horizon-age year and ignores taxes, portfolio interaction, spousal/survivor benefits, and discounting.',
    'The sequencing projection reuses the drawdown engine with spending starting immediately, an identical nominal return on every bucket ((1 + real return) × (1 + COLA) − 1), no state income tax, and half of each taxable withdrawal treated as long-term gain.',
    'IRMAA headroom compares the first model year’s federal AGI (MAGI proxy: no tax-exempt interest) to the 2026 tiers.',
    'The first-year RMD estimate applies the full household traditional balance, grown at the real return, to each person.',
  ];
  if (settings.sequencingPreference === 'proportional') {
    assumptions.push('A proportional withdrawal blend cannot be expressed as a drawdown-engine sequencing order, so the comparison covers taxable-first and traditional-first only.');
  }
  for (const person of people) {
    if (person.piaSource === 'estimated') {
      assumptions.push(`${person.name}'s PIA is estimated from constant real earnings starting at age ${ASSUMED_CAREER_START_AGE} using the SSA AIME/bend-point formula.`);
    }
  }

  return {
    settings,
    asOfDate,
    currentYear,
    people,
    sequencing,
    irmaa,
    rmd,
    assumptions,
  };
}
