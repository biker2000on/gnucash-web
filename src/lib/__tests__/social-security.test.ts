import { describe, it, expect } from 'vitest';
import {
  fullRetirementAgeMonths,
  fullRetirementAgeYears,
  fullRetirementAgeLabel,
  ownBenefitFactor,
  spousalBenefitFactor,
  computeSpouseOutcome,
  compareClaimingStrategies,
  buildSsIncomeStreams,
} from '../social-security';

describe('social-security', () => {
  // ---------------------------------------------------------------------
  // FRA lookup
  // ---------------------------------------------------------------------
  describe('fullRetirementAge', () => {
    it('is 66 for 1943-1954 births', () => {
      expect(fullRetirementAgeMonths(1943)).toBe(66 * 12);
      expect(fullRetirementAgeMonths(1954)).toBe(66 * 12);
    });

    it('phases in 2 months per year for 1955-1959', () => {
      expect(fullRetirementAgeMonths(1955)).toBe(66 * 12 + 2);
      expect(fullRetirementAgeMonths(1957)).toBe(66 * 12 + 6);
      expect(fullRetirementAgeMonths(1959)).toBe(66 * 12 + 10);
    });

    it('is 67 for 1960 and later', () => {
      expect(fullRetirementAgeMonths(1960)).toBe(67 * 12);
      expect(fullRetirementAgeMonths(1975)).toBe(67 * 12);
      expect(fullRetirementAgeYears(1960)).toBeCloseTo(67, 10);
      expect(fullRetirementAgeLabel(1960)).toBe('67');
      expect(fullRetirementAgeLabel(1959)).toBe('66 and 10 months');
    });
  });

  // ---------------------------------------------------------------------
  // Own-benefit factors (boundaries at 62 / FRA / 70)
  // ---------------------------------------------------------------------
  describe('ownBenefitFactor', () => {
    it('reduces 5/9%/mo for 36 months + 5/12%/mo beyond (FRA 67, claim 62)', () => {
      // 60 months early: 36 * 5/9% = 20%, 24 * 5/12% = 10% → factor 0.70
      expect(ownBenefitFactor(1960, 62)).toBeCloseTo(0.70, 10);
    });

    it('is exactly 1 at FRA', () => {
      expect(ownBenefitFactor(1960, 67)).toBeCloseTo(1, 10);
      expect(ownBenefitFactor(1954, 66)).toBeCloseTo(1, 10);
    });

    it('earns 8%/yr delayed credits to 70 (FRA 67)', () => {
      // 36 months delayed * 2/3% = 24%
      expect(ownBenefitFactor(1960, 70)).toBeCloseTo(1.24, 10);
      // FRA 66 → 48 months delayed = 32%
      expect(ownBenefitFactor(1954, 70)).toBeCloseTo(1.32, 10);
    });

    it('handles fractional FRAs (1957: FRA 66+6mo)', () => {
      // Claim 62 → 54 months early: 36*5/9% + 18*5/12% = 20% + 7.5% → 0.725
      expect(ownBenefitFactor(1957, 62)).toBeCloseTo(0.725, 10);
      // Claim 70 → 42 months delayed → +28%
      expect(ownBenefitFactor(1957, 70)).toBeCloseTo(1.28, 10);
    });

    it('clamps claiming outside 62-70', () => {
      expect(ownBenefitFactor(1960, 60)).toBeCloseTo(ownBenefitFactor(1960, 62), 10);
      expect(ownBenefitFactor(1960, 75)).toBeCloseTo(ownBenefitFactor(1960, 70), 10);
    });
  });

  // ---------------------------------------------------------------------
  // Spousal factors
  // ---------------------------------------------------------------------
  describe('spousalBenefitFactor', () => {
    it('reduces 25/36%/mo for 36 months + 5/12%/mo beyond (FRA 67, start 62)', () => {
      // 60 months early: 36 * 25/36% = 25%, 24 * 5/12% = 10% → 0.65
      expect(spousalBenefitFactor(1960, 62)).toBeCloseTo(0.65, 10);
    });

    it('is 1 at FRA and earns NO delayed credits after', () => {
      expect(spousalBenefitFactor(1960, 67)).toBeCloseTo(1, 10);
      expect(spousalBenefitFactor(1960, 70)).toBeCloseTo(1, 10);
    });

    it('partial reduction inside the first 36 months', () => {
      // FRA 67, start 65 → 24 months early: 24 * 25/36% = 16.6667% → 0.8333...
      expect(spousalBenefitFactor(1960, 65)).toBeCloseTo(1 - 24 * (25 / 36 / 100), 10);
    });
  });

  // ---------------------------------------------------------------------
  // Spouse outcome (own + spousal top-up)
  // ---------------------------------------------------------------------
  describe('computeSpouseOutcome', () => {
    const higher = { piaMonthly: 2400, birthYear: 1962 };
    const lower = { piaMonthly: 800, birthYear: 1964 };

    it('adds a spousal top-up when half the other PIA exceeds own PIA', () => {
      // Both claim at FRA (67): excess = 2400/2 - 800 = 400, factor 1.
      const outcome = computeSpouseOutcome(lower, higher, 67, 67, 90);
      expect(outcome.monthlyOwn).toBe(800);
      expect(outcome.monthlySpousal).toBe(400);
      // Higher earner (1962) hits 67 in 2029; lower (1964) is 65 then, so the
      // top-up begins at the lower earner's own claim (67, later).
      expect(outcome.spousalStartAge).toBe(67);
    });

    it('reduces the top-up when the spousal benefit starts early', () => {
      // Both claim at 62. Higher (1962) files when lower (1964) is 60, so the
      // spousal start is the lower earner's own claim at 62 → factor 0.65.
      const outcome = computeSpouseOutcome(lower, higher, 62, 62, 90);
      expect(outcome.monthlyOwn).toBe(Math.round(800 * 0.7));
      expect(outcome.monthlySpousal).toBe(Math.round(400 * 0.65));
      expect(outcome.spousalStartAge).toBe(62);
    });

    it('delays the top-up until the other spouse files', () => {
      // Lower claims 62, higher waits to 70. Higher (1962) turns 70 in 2032;
      // lower (1964) is 68 then → top-up starts at 68, factor 1 (past FRA).
      const outcome = computeSpouseOutcome(lower, higher, 62, 70, 90);
      expect(outcome.spousalStartAge).toBe(68);
      expect(outcome.monthlySpousal).toBe(400);
    });

    it('gives the higher earner no spousal top-up', () => {
      const outcome = computeSpouseOutcome(higher, lower, 67, 67, 90);
      expect(outcome.monthlySpousal).toBe(0);
      expect(outcome.spousalStartAge).toBeNull();
    });

    it('sums nominal lifetime benefits to the longevity age', () => {
      // Single: 2000/mo at 67 through 90 = 2000 * 276 months.
      const single = computeSpouseOutcome({ piaMonthly: 2000, birthYear: 1960 }, null, 67, null, 90);
      expect(single.lifetimeTotal).toBe(2000 * (90 - 67) * 12);
    });
  });

  // ---------------------------------------------------------------------
  // Strategy comparison
  // ---------------------------------------------------------------------
  describe('compareClaimingStrategies', () => {
    const input = {
      self: { piaMonthly: 2400, birthYear: 1962 },
      spouse: { piaMonthly: 800, birthYear: 1964 },
      customClaimAgeSelf: 68,
      customClaimAgeSpouse: 64,
      longevityAge: 90,
    };

    it('returns both-62, both-FRA, split, and custom strategies', () => {
      const results = compareClaimingStrategies(input);
      expect(results.map(r => r.key)).toEqual(['both_62', 'both_fra', 'split', 'custom']);

      const both62 = results[0];
      expect(both62.self.claimAge).toBe(62);
      expect(both62.spouse!.claimAge).toBe(62);

      const split = results[2];
      // Self has the higher PIA → delays to 70; spouse claims at 62.
      expect(split.self.claimAge).toBe(70);
      expect(split.spouse!.claimAge).toBe(62);

      const custom = results[3];
      expect(custom.self.claimAge).toBe(68);
      expect(custom.spouse!.claimAge).toBe(64);
    });

    it('householdLifetime equals the sum of both spouses', () => {
      for (const r of compareClaimingStrategies(input)) {
        expect(r.householdLifetime).toBe(r.self.lifetimeTotal + (r.spouse?.lifetimeTotal ?? 0));
      }
    });

    it('with long longevity, delaying beats claiming at 62', () => {
      const results = compareClaimingStrategies({ ...input, longevityAge: 95 });
      const both62 = results.find(r => r.key === 'both_62')!;
      const bothFra = results.find(r => r.key === 'both_fra')!;
      expect(bothFra.householdLifetime).toBeGreaterThan(both62.householdLifetime);
    });

    it('with short longevity, claiming early wins', () => {
      const results = compareClaimingStrategies({ ...input, longevityAge: 75 });
      const both62 = results.find(r => r.key === 'both_62')!;
      const split = results.find(r => r.key === 'split')!;
      expect(both62.householdLifetime).toBeGreaterThan(split.householdLifetime);
    });

    it('handles singles (no spouse): 62 / FRA / 70 / custom', () => {
      const results = compareClaimingStrategies({
        self: { piaMonthly: 2000, birthYear: 1960 },
        spouse: null,
        customClaimAgeSelf: 65,
        longevityAge: 90,
      });
      expect(results[0].self.claimAge).toBe(62);
      expect(results[1].self.claimAge).toBe(67);
      expect(results[2].self.claimAge).toBe(70);
      expect(results[3].self.claimAge).toBe(65);
      for (const r of results) expect(r.spouse).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // Drawdown bridge
  // ---------------------------------------------------------------------
  describe('buildSsIncomeStreams', () => {
    it('translates the spouse claim age into primary-filer age', () => {
      const streams = buildSsIncomeStreams(
        {
          self: { piaMonthly: 2400, birthYear: 1962 },
          spouse: { piaMonthly: 2000, birthYear: 1965 },
          customClaimAgeSelf: 70,
          customClaimAgeSpouse: 62,
          longevityAge: 90,
        },
        70,
        62,
      );
      // Spouse (1965) claims at 62 in 2027 — self (1962) is 65 then.
      const spouseStream = streams.find(s => s.startAge === 65);
      expect(spouseStream).toBeDefined();
      expect(spouseStream!.annualBenefit).toBe(Math.round(2000 * 0.7) * 12);
      // Self stream at 70 with delayed credits.
      const selfStream = streams.find(s => s.startAge === 70);
      expect(selfStream!.annualBenefit).toBe(Math.round(2400 * 1.24) * 12);
    });

    it('emits a spousal top-up stream when applicable', () => {
      const streams = buildSsIncomeStreams(
        {
          self: { piaMonthly: 800, birthYear: 1962 },
          spouse: { piaMonthly: 2400, birthYear: 1962 },
          customClaimAgeSelf: 67,
          customClaimAgeSpouse: 67,
          longevityAge: 90,
        },
        67,
        67,
      );
      // Own 800 at 67, spousal top-up 400 starting at 67 (same birth years).
      const topUp = streams.filter(s => s.startAge === 67);
      const total = topUp.reduce((sum, s) => sum + s.annualBenefit, 0);
      expect(total).toBe(800 * 12 + 400 * 12 + 2400 * 12);
    });

    it('streams are sorted by start age', () => {
      const streams = buildSsIncomeStreams(
        {
          self: { piaMonthly: 2400, birthYear: 1960 },
          spouse: { piaMonthly: 1000, birthYear: 1958 },
          customClaimAgeSelf: 70,
          customClaimAgeSpouse: 62,
          longevityAge: 90,
        },
        70,
        62,
      );
      const ages = streams.map(s => s.startAge);
      expect([...ages].sort((a, b) => a - b)).toEqual(ages);
    });
  });
});
