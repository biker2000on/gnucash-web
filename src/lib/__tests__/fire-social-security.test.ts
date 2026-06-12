/**
 * Social Security benefit engine tests.
 *
 * SSA figures verified against ssa.gov (June 2026):
 * - Bend points (https://www.ssa.gov/oact/cola/bendpoints.html):
 *   2022: $1,024/$6,172 · 2024: $1,174/$7,078 · 2025: $1,226/$7,391 · 2026: $1,286/$7,749
 * - AWI (https://www.ssa.gov/oact/cola/awiseries.html): 2024 = $69,846.57 (latest)
 * - Wage base (https://www.ssa.gov/oact/cola/cbb.html): 2024 = $168,600 · 2026 = $184,500
 * - COLA (https://www.ssa.gov/oact/cola/colaseries.html): 2022 = 8.7 · 2023 = 3.2 · 2024 = 2.5 · 2025 = 2.8
 */

import { describe, it, expect } from 'vitest';
import {
  AWI_SERIES,
  PIA_BEND_POINTS,
  WAGE_BASE,
  wageBaseForYear,
  awiForYear,
  claimingAdjustmentFactor,
  normalRetirementAgeMonths,
  normalRetirementAgeLabel,
  estimateFutureParams,
  LATEST_AWI_YEAR,
} from '@/lib/fire/ssa-params';
import {
  computeAIME,
  computePIA,
  roundDownToDime,
  applyColas,
  estimateSocialSecurityBenefit,
} from '@/lib/fire/social-security';

describe('SSA parameter tables', () => {
  it('contains verified published values', () => {
    expect(AWI_SERIES[2024]).toBe(69846.57);
    expect(AWI_SERIES[1951]).toBe(2799.16);
    expect(PIA_BEND_POINTS[2024]).toEqual([1174, 7078]);
    expect(PIA_BEND_POINTS[2025]).toEqual([1226, 7391]);
    expect(PIA_BEND_POINTS[2026]).toEqual([1286, 7749]);
    expect(WAGE_BASE[2024]).toBe(168600);
    expect(WAGE_BASE[2026]).toBe(184500);
  });

  it('reproduces published bend points from the AWI formula', () => {
    // bend(Y) = 1979 amounts x AWI(Y-2)/AWI(1977)
    const ratio2026 = AWI_SERIES[2024] / AWI_SERIES[1977];
    expect(Math.round(180 * ratio2026)).toBe(PIA_BEND_POINTS[2026][0]);
    expect(Math.round(1085 * ratio2026)).toBe(PIA_BEND_POINTS[2026][1]);
  });

  it('normal retirement age follows the statutory schedule', () => {
    expect(normalRetirementAgeMonths(1937)).toBe(65 * 12);
    expect(normalRetirementAgeMonths(1940)).toBe(65 * 12 + 6);
    expect(normalRetirementAgeMonths(1943)).toBe(66 * 12);
    expect(normalRetirementAgeMonths(1954)).toBe(66 * 12);
    expect(normalRetirementAgeMonths(1957)).toBe(66 * 12 + 6);
    expect(normalRetirementAgeMonths(1959)).toBe(66 * 12 + 10);
    expect(normalRetirementAgeMonths(1960)).toBe(67 * 12);
    expect(normalRetirementAgeMonths(1980)).toBe(67 * 12);
    expect(normalRetirementAgeLabel(1960)).toBe('67');
    expect(normalRetirementAgeLabel(1959)).toBe('66 and 10 months');
  });

  it('claiming adjustment: NRA 67 gives 70% at 62 and 124% at 70', () => {
    expect(claimingAdjustmentFactor(1960, 62 * 12)).toBeCloseTo(0.7, 10);
    expect(claimingAdjustmentFactor(1960, 67 * 12)).toBe(1);
    expect(claimingAdjustmentFactor(1960, 70 * 12)).toBeCloseTo(1.24, 10);
    // 5/9% x 36 + 5/12% x 12 = 25% at 36+12 months early (claim 63, NRA 67)
    expect(claimingAdjustmentFactor(1960, 63 * 12)).toBeCloseTo(0.75, 10);
    // NRA 66y10m (born 1959): 58 months early = 20% + 22 x 5/12% = 29.1666%
    expect(claimingAdjustmentFactor(1959, 62 * 12)).toBeCloseTo(1 - (0.2 + (22 * 5) / 12 / 100), 10);
    // Credits stop at 70
    expect(claimingAdjustmentFactor(1960, 72 * 12)).toBeCloseTo(1.24, 10);
  });

  it('estimateFutureParams: published years exact, future years extrapolate', () => {
    const p2024 = estimateFutureParams(2024);
    expect(p2024.awi).toBe(69846.57);
    expect(p2024.estimated).toBe(false);

    // 0% growth freezes everything at today's values (today's dollars)
    const p2040 = estimateFutureParams(2040, 0);
    expect(p2040.estimated).toBe(true);
    expect(p2040.awi).toBe(AWI_SERIES[LATEST_AWI_YEAR]);
    expect(p2040.wageBase).toBe(184500);
    expect(p2040.bendPoints).toEqual([1286, 7749]);

    // Positive growth compounds AWI and scales bend points/wage base with it
    const p2030 = estimateFutureParams(2030, 4);
    expect(p2030.awi).toBeCloseTo(AWI_SERIES[2024] * Math.pow(1.04, 6), 6);
    expect(p2030.bendPoints[0]).toBeGreaterThan(1286);
    expect(p2030.wageBase % 300).toBe(0);
    expect(p2030.wageBase).toBeGreaterThan(184500);
  });

  it('awiForYear / wageBaseForYear clamp early years', () => {
    expect(awiForYear(1900)).toBe(AWI_SERIES[1951]);
    expect(wageBaseForYear(1940)).toBe(3000);
  });
});

describe('PIA building blocks', () => {
  it('rounds PIA down to the next lower dime', () => {
    expect(roundDownToDime(3225.56)).toBe(3225.5);
    expect(roundDownToDime(1157.4000000000001)).toBe(1157.4);
    expect(roundDownToDime(489.15)).toBe(489.1);
    expect(roundDownToDime(100)).toBe(100);
  });

  it('computes PIA at the 2026 bend points (90/32/15)', () => {
    const bp = [1286, 7749] as const;
    expect(computePIA(500, bp)).toBe(450); // all in 90% band
    expect(computePIA(1286, bp)).toBe(1157.4); // exactly first bend
    // 1157.40 + 0.32 x 6463 = 3225.56 -> 3225.50
    expect(computePIA(7749, bp)).toBe(3225.5);
    // 3225.56 + 0.15 x 2251 = 3563.21 -> 3563.20
    expect(computePIA(10000, bp)).toBe(3563.2);
    expect(computePIA(0, bp)).toBe(0);
  });

  it('computeAIME floors the top-35 monthly average and zero-fills', () => {
    // 10 years at 42,000 indexed: AIME = floor(420,000 / 420) = 1,000
    expect(computeAIME(Array(10).fill(42000))).toBe(1000);
    // More than 35 years: only the highest 35 count (5 x 99,999 + 30 x 42,000)
    const many = [...Array(40).fill(42000), ...Array(5).fill(99999)];
    expect(computeAIME(many)).toBe(Math.floor((5 * 99999 + 30 * 42000) / 420));
    expect(computeAIME([])).toBe(0);
  });

  it('applies COLAs with dime rounding at each step', () => {
    // Eligibility 2022: 8.7%, 3.2%, 2.5%, 2.8%
    // 450 -> 489.1 -> 504.7 -> 517.3 -> 531.7
    expect(applyColas(450, 2022)).toBe(531.7);
    // Future eligibility year: no published COLAs apply
    expect(applyColas(450, 2042)).toBe(450);
  });
});

describe('estimateSocialSecurityBenefit', () => {
  // Born 1960: indexing year 2020, eligibility 2022 (bend 1,024/6,172), NRA 67.
  // Earnings 2020-2024 at $42,000 (all >= age-60 year, so index factor 1).
  // AIME = floor(210,000/420) = 500 -> PIA 450.00 -> COLAs -> 531.70.
  const born1960 = {
    birthYear: 1960,
    earnings: [2020, 2021, 2022, 2023, 2024].map(year => ({ year, earnings: 42000 })),
    projectFutureEarnings: false,
  };

  it('hand-computed example: PIA, COLAs, and claiming factors line up', () => {
    const at67 = estimateSocialSecurityBenefit({ ...born1960, claimingAge: 67 });
    expect(at67.diagnostics.aime).toBe(500);
    expect(at67.diagnostics.bendPoints).toEqual([1024, 6172]);
    expect(at67.diagnostics.piaAtEligibility).toBe(450);
    expect(at67.diagnostics.pia).toBe(531.7);
    expect(at67.diagnostics.nraLabel).toBe('67');
    expect(at67.monthlyBenefit).toBe(531); // truncated to the dollar
    expect(at67.annualBenefit).toBe(531 * 12);

    const at62 = estimateSocialSecurityBenefit({ ...born1960, claimingAge: 62 });
    expect(at62.diagnostics.claimingAdjustment).toBeCloseTo(0.7, 10);
    expect(at62.monthlyBenefit).toBe(372); // floor(531.70 x 0.70 = 372.19)

    const at70 = estimateSocialSecurityBenefit({ ...born1960, claimingAge: 70 });
    expect(at70.diagnostics.claimingAdjustment).toBeCloseTo(1.24, 10);
    expect(at70.monthlyBenefit).toBe(659); // floor(531.70 x 1.24 = 659.308)
  });

  it('caps earnings at the taxable wage base per year', () => {
    const result = estimateSocialSecurityBenefit({
      birthYear: 1962, // indexing year 2024
      claimingAge: 67,
      projectFutureEarnings: false,
      earnings: [
        { year: 2023, earnings: 1_000_000 },
        { year: 2024, earnings: 1_000_000 },
      ],
    });
    const row2023 = result.diagnostics.top35.find(r => r.year === 2023)!;
    const row2024 = result.diagnostics.top35.find(r => r.year === 2024)!;
    expect(row2023.capped).toBe(160200);
    expect(row2024.capped).toBe(168600);
    expect(row2024.indexFactor).toBe(1);
  });

  it('indexes by AWI through the age-60 year and 1.0 after', () => {
    const result = estimateSocialSecurityBenefit({
      birthYear: 1960, // indexing year 2020
      claimingAge: 67,
      projectFutureEarnings: false,
      earnings: [
        { year: 1990, earnings: 20000 },
        { year: 2021, earnings: 50000 },
      ],
    });
    const row1990 = result.diagnostics.top35.find(r => r.year === 1990)!;
    const row2021 = result.diagnostics.top35.find(r => r.year === 2021)!;
    const expectedFactor = AWI_SERIES[2020] / AWI_SERIES[1990];
    expect(row1990.indexFactor).toBeCloseTo(expectedFactor, 10);
    expect(row1990.indexed).toBeCloseTo(20000 * expectedFactor, 6);
    expect(row2021.indexFactor).toBe(1); // after age-60 year: no indexing
    expect(row2021.indexed).toBe(50000);
  });

  it('zero-fills the top 35 when history is short', () => {
    const result = estimateSocialSecurityBenefit({ ...born1960, claimingAge: 67 });
    expect(result.diagnostics.yearsWithEarnings).toBe(5);
    expect(result.diagnostics.zeroYearsInTop35).toBe(30);
  });

  it('projects continued earnings until the year before claiming', () => {
    const result = estimateSocialSecurityBenefit({
      birthYear: 1980, // indexing year 2040 (extrapolated), claim year 2047
      claimingAge: 67,
      projectFutureEarnings: true,
      earnings: [2020, 2021, 2022, 2023, 2024, 2025].map(year => ({ year, earnings: 100000 })),
    });
    // Projected 2026..2046 = 21 years
    expect(result.diagnostics.projectedYears).toBe(21);
    expect(result.diagnostics.usedEstimatedParams).toBe(true);
    expect(result.diagnostics.eligibilityYear).toBe(2042);
    // Future eligibility: today's-dollar bend points, no COLAs
    expect(result.diagnostics.bendPoints).toEqual([1286, 7749]);
    expect(result.diagnostics.pia).toBe(result.diagnostics.piaAtEligibility);

    // Projected years at 0% growth enter at face value (constant real earnings)
    const projected = result.diagnostics.top35.filter(r => r.projected);
    expect(projected.length).toBeGreaterThan(0);
    for (const row of projected) {
      expect(row.indexed).toBe(100000);
    }

    // Hand-compute the AIME: actual years indexed by frozen AWI(2024)/AWI(y)
    const awi24 = AWI_SERIES[2024];
    const actualSum =
      100000 * (awi24 / AWI_SERIES[2020]) +
      100000 * (awi24 / AWI_SERIES[2021]) +
      100000 * (awi24 / AWI_SERIES[2022]) +
      100000 * (awi24 / AWI_SERIES[2023]) +
      100000 + // 2024: factor 1
      100000; // 2025: frozen AWI -> factor 1
    const expectedAime = Math.floor((actualSum + 21 * 100000) / 420);
    expect(result.diagnostics.aime).toBe(expectedAime);
    expect(result.monthlyBenefit).toBe(
      Math.floor(computePIA(expectedAime, [1286, 7749])),
    );
  });

  it('projection toggle off uses only actual history', () => {
    const base = {
      birthYear: 1980,
      claimingAge: 67 as const,
      earnings: [{ year: 2024, earnings: 100000 }, { year: 2025, earnings: 100000 }],
    };
    const withProjection = estimateSocialSecurityBenefit({ ...base, projectFutureEarnings: true });
    const withoutProjection = estimateSocialSecurityBenefit({ ...base, projectFutureEarnings: false });
    expect(withoutProjection.diagnostics.projectedYears).toBe(0);
    expect(withProjection.monthlyBenefit).toBeGreaterThan(withoutProjection.monthlyBenefit);
  });

  it('handles sparse history gracefully', () => {
    const result = estimateSocialSecurityBenefit({
      birthYear: 1990,
      claimingAge: 67,
      projectFutureEarnings: false,
      earnings: [
        { year: 2023, earnings: 60000 },
        { year: 2024, earnings: 62000 },
        { year: 2025, earnings: 64000 },
      ],
    });
    expect(result.diagnostics.yearsWithEarnings).toBe(3);
    expect(result.diagnostics.zeroYearsInTop35).toBe(32);
    expect(result.monthlyBenefit).toBeGreaterThan(0);
  });

  it('ignores non-positive earnings and empty history', () => {
    const result = estimateSocialSecurityBenefit({
      birthYear: 1980,
      claimingAge: 67,
      projectFutureEarnings: false,
      earnings: [
        { year: 2023, earnings: -500 },
        { year: 2024, earnings: 0 },
      ],
    });
    expect(result.diagnostics.yearsWithEarnings).toBe(0);
    expect(result.monthlyBenefit).toBe(0);

    const empty = estimateSocialSecurityBenefit({
      birthYear: 1980,
      claimingAge: 67,
      earnings: [],
    });
    expect(empty.monthlyBenefit).toBe(0);
  });

  it('clamps claiming age to the 62-70 window', () => {
    const at55 = estimateSocialSecurityBenefit({ ...born1960, claimingAge: 55 });
    const at62 = estimateSocialSecurityBenefit({ ...born1960, claimingAge: 62 });
    expect(at55.monthlyBenefit).toBe(at62.monthlyBenefit);
    const at75 = estimateSocialSecurityBenefit({ ...born1960, claimingAge: 75 });
    const at70 = estimateSocialSecurityBenefit({ ...born1960, claimingAge: 70 });
    expect(at75.monthlyBenefit).toBe(at70.monthlyBenefit);
  });
});
