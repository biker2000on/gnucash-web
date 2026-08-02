import { describe, expect, it } from 'vitest';
import {
  CLAIMING_DELTA_ACTION_THRESHOLD,
  IRMAA_CLIFF_WINDOW,
  SEQUENCING_DELTA_ACTION_THRESHOLD,
  analyzeRetirementIncome,
} from '../retirement-income-core';
import type { RetirementIncomeProfile, RetirementIncomeSettings } from '../types';

const asOf = new Date('2026-08-01T12:00:00Z');

const settings: RetirementIncomeSettings = {
  filingStatus: 'single',
  annualSpending: 60_000,
  horizonAge: 90,
  colaPct: 2.5,
  realReturnPct: 4,
  sequencingPreference: 'taxable_first',
};

const balances = { taxable: 500_000, traditional: 500_000, roth: 200_000, hsa: 0 };

function profileWith(overrides: Partial<RetirementIncomeProfile> = {}): RetirementIncomeProfile {
  return {
    people: [
      { id: 'p1', name: 'Alex', birthYear: 1960, pia: 2_000, plannedClaimAge: 67 },
    ],
    balances: { ...balances },
    settings: { ...settings },
    ...overrides,
  };
}

describe('analyzeRetirementIncome — claiming comparison', () => {
  it('applies the SSA early-reduction and delayed-credit factors exactly for a 1960 birth year', () => {
    const result = analyzeRetirementIncome(profileWith(), asOf);
    const person = result.people[0];
    expect(person.currentAge).toBe(66);
    expect(person.fraMonths).toBe(804); // FRA 67 for 1960+
    expect(person.fraLabel).toBe('67');
    expect(person.piaSource).toBe('entered');
    const [early, fra, late] = person.options;
    // 60 months early: 36 × 5/9% + 24 × 5/12% = 30% reduction.
    expect(early.claimAgeYears).toBe(62);
    expect(early.monthlyBenefit).toBe(1_400);
    expect(early.annualBenefit).toBe(16_800);
    // At FRA the PIA passes through unchanged.
    expect(fra.monthlyBenefit).toBe(2_000);
    // 36 months delayed × 2/3% = +24%.
    expect(late.claimAgeYears).toBe(70);
    expect(late.monthlyBenefit).toBe(2_480);
  });

  it('computes exact lifetime totals, breakevens, and the recommendation with 0% COLA', () => {
    const result = analyzeRetirementIncome(profileWith({
      settings: { ...settings, colaPct: 0 },
    }), asOf);
    const person = result.people[0];
    const [early, fra, late] = person.options;
    // Months received through the end of the age-90 year: 348 / 288 / 252.
    expect(early.lifetimeTotal).toBe(487_200); // 1400 × 348
    expect(fra.lifetimeTotal).toBe(576_000); // 2000 × 288
    expect(late.lifetimeTotal).toBe(624_960); // 2480 × 252
    expect(person.recommendedClaimAge).toBe(70);
    expect(person.recommendedMonthlyBenefit).toBe(2_480);
    expect(person.plannedLifetimeTotal).toBe(576_000);
    expect(person.lifetimeDelta).toBe(48_960); // 624,960 − 576,000
    expect(person.lifetimeDelta).toBeGreaterThan(CLAIMING_DELTA_ACTION_THRESHOLD);
    const breakevens = Object.fromEntries(
      person.breakevens.map(row => [`${row.earlierLabel}|${row.laterLabel}`, row.breakevenAge]));
    expect(breakevens['62|FRA (67)']).toBe(78.6);
    expect(breakevens['62|70']).toBe(80.3);
    expect(breakevens['FRA (67)|70']).toBe(82.4);
  });

  it('grows lifetime totals when a COLA compounds from age 62', () => {
    const withCola = analyzeRetirementIncome(profileWith(), asOf);
    const withoutCola = analyzeRetirementIncome(profileWith({
      settings: { ...settings, colaPct: 0 },
    }), asOf);
    for (let index = 0; index < 3; index++) {
      expect(withCola.people[0].options[index].lifetimeTotal)
        .toBeGreaterThan(withoutCola.people[0].options[index].lifetimeTotal);
    }
    // COLA never changes the monthly benefit at claim in today's dollars.
    expect(withCola.people[0].options[1].monthlyBenefit).toBe(2_000);
  });

  it('reports a null breakeven when the later claim never catches up within the horizon', () => {
    const result = analyzeRetirementIncome(profileWith({
      settings: { ...settings, colaPct: 0, horizonAge: 75 },
    }), asOf);
    const person = result.people[0];
    const pair = person.breakevens.find(row => row.earlierLabel === '62' && row.laterLabel === '70');
    expect(pair?.breakevenAge).toBeNull();
    // With a short horizon, claiming early wins outright.
    expect(person.recommendedClaimAge).toBe(62);
  });

  it('estimates a PIA from annual earnings when pia is 0, and marks empty inputs missing', () => {
    const result = analyzeRetirementIncome(profileWith({
      people: [
        { id: 'p1', name: 'Alex', birthYear: 1970, pia: 0, annualEarnings: 60_000, plannedClaimAge: 67 },
        { id: 'p2', name: 'Sam', birthYear: 1972, pia: 0, plannedClaimAge: 67 },
      ],
      settings: { ...settings, filingStatus: 'married_joint' },
    }), asOf);
    const [estimated, missing] = result.people;
    expect(estimated.piaSource).toBe('estimated');
    expect(estimated.pia).toBeGreaterThan(0);
    expect(estimated.options[1].monthlyBenefit).toBeGreaterThan(0);
    expect(result.assumptions.some(line => line.includes("Alex's PIA is estimated"))).toBe(true);
    expect(missing.piaSource).toBe('missing');
    expect(missing.pia).toBe(0);
    expect(missing.options.every(option => option.monthlyBenefit === 0)).toBe(true);
    expect(missing.lifetimeDelta).toBe(0);
  });
});

describe('analyzeRetirementIncome — sequencing comparison', () => {
  it('runs the drawdown engine for taxable-first and traditional-first variants', () => {
    const result = analyzeRetirementIncome(profileWith(), asOf);
    const sequencing = result.sequencing;
    expect(sequencing).not.toBeNull();
    expect(sequencing!.variants.map(variant => variant.id)).toEqual(['taxable_first', 'traditional_first']);
    for (const variant of sequencing!.variants) {
      expect(variant.endingTotal).toBeGreaterThan(0);
      expect(variant.lifetimeTax).toBeGreaterThan(0);
      expect(variant.firstYearAgi).toBeGreaterThan(0);
    }
    expect(sequencing!.preferenceSupported).toBe(true);
    expect(sequencing!.preferredVariantId).toBe('taxable_first');
    expect(['taxable_first', 'traditional_first']).toContain(sequencing!.bestVariantId);
    const best = sequencing!.variants.find(variant => variant.id === sequencing!.bestVariantId)!;
    const preferred = sequencing!.variants.find(variant => variant.id === sequencing!.preferredVariantId)!;
    expect(sequencing!.endingValueDelta).toBe(
      Math.round(Math.max(0, best.endingTotal - preferred.endingTotal) * 100) / 100);
    expect(sequencing!.endingValueDelta).toBeGreaterThanOrEqual(0);
    expect(SEQUENCING_DELTA_ACTION_THRESHOLD).toBe(5_000);
  });

  it('marks a proportional preference as unsupported with a stated assumption', () => {
    const result = analyzeRetirementIncome(profileWith({
      settings: { ...settings, sequencingPreference: 'proportional' },
    }), asOf);
    expect(result.sequencing!.preferenceSupported).toBe(false);
    expect(result.sequencing!.preferredVariantId).toBeNull();
    expect(result.sequencing!.endingValueDelta).toBe(0);
    expect(result.assumptions.some(line => line.includes('proportional'))).toBe(true);
  });

  it('returns null sequencing and IRMAA analyses with no people', () => {
    const result = analyzeRetirementIncome(profileWith({ people: [] }), asOf);
    expect(result.people).toEqual([]);
    expect(result.sequencing).toBeNull();
    expect(result.irmaa).toBeNull();
    expect(result.rmd).toEqual([]);
  });
});

describe('analyzeRetirementIncome — IRMAA cliff detection', () => {
  it('builds the 2026 tier table with exact surcharges for a single filer', () => {
    const result = analyzeRetirementIncome(profileWith(), asOf);
    const irmaa = result.irmaa!;
    expect(irmaa.year).toBe(2026);
    expect(irmaa.tiers.map(row => row.threshold)).toEqual([109_000, 137_000, 171_000, 205_000, 500_000]);
    // Tier 1: Part B 202.90 × 0.4 + Part D 14.50 = 95.66/month.
    expect(irmaa.tiers[0].monthlySurcharge).toBe(95.66);
    expect(irmaa.tiers[0].annualSurcharge).toBe(1_147.92);
    const chosen = result.sequencing!.variants.find(variant => variant.id === 'taxable_first')!;
    expect(irmaa.magi).toBe(Math.round(chosen.firstYearAgi * 100) / 100);
  });

  it('uses joint thresholds for married filers and reports consistent headroom', () => {
    const result = analyzeRetirementIncome(profileWith({
      people: [
        { id: 'p1', name: 'Alex', birthYear: 1960, pia: 2_000, plannedClaimAge: 67 },
        { id: 'p2', name: 'Sam', birthYear: 1962, pia: 1_500, plannedClaimAge: 67 },
      ],
      settings: { ...settings, filingStatus: 'married_joint' },
    }), asOf);
    const irmaa = result.irmaa!;
    expect(irmaa.tiers.map(row => row.threshold)).toEqual([218_000, 274_000, 342_000, 410_000, 750_000]);
    expect(irmaa.nextTierThreshold).toBe(irmaa.tiers[irmaa.tier].threshold);
    expect(irmaa.headroomToNextTier).toBe(
      Math.round((irmaa.nextTierThreshold! - irmaa.magi) * 100) / 100);
    expect(irmaa.withinCliff).toBe(irmaa.headroomToNextTier! <= IRMAA_CLIFF_WINDOW);
    expect(irmaa.surchargeDeltaAnnual).toBeGreaterThan(0);
  });
});

describe('analyzeRetirementIncome — RMD context', () => {
  it('computes SECURE 2.0 start ages, first RMD year, and a grown first-year estimate', () => {
    const result = analyzeRetirementIncome(profileWith({
      people: [
        { id: 'p1', name: 'Alex', birthYear: 1960, pia: 2_000, plannedClaimAge: 67 },
        { id: 'p2', name: 'Sam', birthYear: 1955, pia: 1_500, plannedClaimAge: 67 },
      ],
      settings: { ...settings, filingStatus: 'married_joint' },
    }), asOf);
    const [alex, sam] = result.rmd;
    expect(alex.rmdStartAge).toBe(75); // born 1960 or later
    expect(alex.firstRmdYear).toBe(2035);
    expect(alex.yearsUntilFirstRmd).toBe(9);
    // 500,000 × 1.04^9 ÷ 24.6 (Uniform Lifetime divisor at 75).
    expect(alex.estimatedFirstRmd).toBeCloseTo(28_929.1, 1);
    expect(sam.rmdStartAge).toBe(73); // born before 1960
    expect(sam.firstRmdYear).toBe(2028);
    expect(sam.yearsUntilFirstRmd).toBe(2);
    // 500,000 × 1.04^2 ÷ 26.5 (divisor at 73).
    expect(sam.estimatedFirstRmd).toBeCloseTo(20_407.55, 2);
  });

  it('does not grow the balance for a person already past the RMD start age', () => {
    const result = analyzeRetirementIncome(profileWith({
      people: [{ id: 'p1', name: 'Pat', birthYear: 1950, pia: 1_800, plannedClaimAge: 66 }],
      settings: { ...settings, horizonAge: 95 },
    }), asOf);
    const context = result.rmd[0];
    expect(context.rmdStartAge).toBe(73);
    expect(context.firstRmdYear).toBe(2023);
    expect(context.yearsUntilFirstRmd).toBe(-3);
    // No growth applied when the start age is in the past: 500,000 ÷ 26.5.
    expect(context.estimatedFirstRmd).toBe(18_867.92);
  });
});
