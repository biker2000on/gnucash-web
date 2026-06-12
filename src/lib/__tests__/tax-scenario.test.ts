import { describe, it, expect } from 'vitest';
import {
  evaluateScenario,
  validateScenario,
  remainingHeadroom,
  applyScenario,
  maxOutScenario,
  type ScenarioLimits,
} from '@/lib/tax/scenario';
import { computeFederalTax, emptyFederalInputs } from '@/lib/tax/federal';
import { computeStateTax } from '@/lib/tax/state';
import type { ContributionScenario, FederalTaxInputs } from '@/lib/tax/types';

const LIMITS: ScenarioLimits = {
  limits: { trad401k: 23_500, roth401k: 23_500, tradIra: 7_000, rothIra: 7_000, hsa: 4_300 },
  actuals: { trad401k: 10_000, roth401k: 2_000, tradIra: 0, rothIra: 3_000, hsa: 1_000 },
};

function scenario(additional: Partial<ContributionScenario['additional']>, name = 'Test'): ContributionScenario {
  return {
    name,
    additional: { trad401k: 0, roth401k: 0, tradIra: 0, rothIra: 0, hsa: 0, ...additional },
  };
}

function baseInputs(): FederalTaxInputs {
  return {
    ...emptyFederalInputs(2025, 'single'),
    wages: 150_000,
    traditional401kContributions: 10_000,
    hsaContributions: 1_000,
  };
}

describe('remainingHeadroom', () => {
  it('401k headroom is shared between traditional and Roth', () => {
    // 23,500 − (10,000 + 2,000) = 11,500
    expect(remainingHeadroom('trad401k', LIMITS)).toBe(11_500);
    expect(remainingHeadroom('roth401k', LIMITS)).toBe(11_500);
  });

  it('IRA headroom shared between trad and Roth', () => {
    expect(remainingHeadroom('tradIra', LIMITS)).toBe(4_000);
  });

  it('HSA standalone', () => {
    expect(remainingHeadroom('hsa', LIMITS)).toBe(3_300);
  });

  it('null when no limit known', () => {
    const noLimits: ScenarioLimits = {
      limits: { trad401k: null, roth401k: null, tradIra: null, rothIra: null, hsa: null },
      actuals: LIMITS.actuals,
    };
    expect(remainingHeadroom('trad401k', noLimits)).toBeNull();
  });
});

describe('validateScenario', () => {
  it('passes when within headroom', () => {
    expect(validateScenario(scenario({ trad401k: 11_500 }), LIMITS)).toHaveLength(0);
  });

  it('fails when exceeding shared 401k limit', () => {
    const issues = validateScenario(scenario({ trad401k: 8_000, roth401k: 5_000 }), LIMITS);
    expect(issues).toHaveLength(1);
    expect(issues[0].remaining).toBe(11_500);
    expect(issues[0].requested).toBe(13_000);
  });

  it('fails when exceeding IRA limit', () => {
    const issues = validateScenario(scenario({ tradIra: 5_000 }), LIMITS);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('tradIra');
  });

  it('rejects negative amounts', () => {
    const issues = validateScenario(scenario({ hsa: -100 }), LIMITS);
    expect(issues.some(i => i.message.includes('negative'))).toBe(true);
  });
});

describe('applyScenario', () => {
  it('adds pre-tax contributions but not Roth', () => {
    const applied = applyScenario(baseInputs(), scenario({ trad401k: 5_000, roth401k: 5_000, hsa: 1_000 }));
    expect(applied.traditional401kContributions).toBe(15_000);
    expect(applied.hsaContributions).toBe(2_000);
    // Roth additions do not alter any federal input
    expect(applied.wages).toBe(150_000);
  });
});

describe('evaluateScenario', () => {
  function baseline(): number {
    const fed = computeFederalTax(baseInputs());
    const st = computeStateTax('PA', {
      year: 2025, filingStatus: 'single', federalAgi: fed.agi,
    });
    return fed.totalTax + st.tax;
  }

  it('traditional 401k addition saves tax and reports take-home change', () => {
    const result = evaluateScenario({
      baseInputs: baseInputs(),
      scenario: scenario({ trad401k: 10_000 }, 'Max 401k'),
      limits: LIMITS,
      stateCode: 'PA',
      baselineLiability: baseline(),
    });
    expect(result.valid).toBe(true);
    expect(result.taxSaved).toBeGreaterThan(2_000); // 24% fed + 3.07% PA on 10k
    expect(result.totalAdditional).toBe(10_000);
    expect(result.takeHomeChange).toBeCloseTo(result.taxSaved - 10_000, 2);
    expect(result.totalLiability).toBeLessThan(result.baselineLiability);
  });

  it('Roth additions save no federal tax', () => {
    const result = evaluateScenario({
      baseInputs: baseInputs(),
      scenario: scenario({ roth401k: 5_000 }),
      limits: LIMITS,
      stateCode: 'PA',
      baselineLiability: baseline(),
    });
    expect(result.taxSaved).toBeCloseTo(0, 2);
    expect(result.takeHomeChange).toBeCloseTo(-5_000, 2);
  });

  it('invalid scenarios still compute but carry issues', () => {
    const result = evaluateScenario({
      baseInputs: baseInputs(),
      scenario: scenario({ tradIra: 50_000 }),
      limits: LIMITS,
      stateCode: 'PA',
      baselineLiability: baseline(),
    });
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe('maxOutScenario', () => {
  it('fills the field with remaining headroom', () => {
    const s = maxOutScenario('hsa', 'Max HSA', LIMITS);
    expect(s.additional.hsa).toBe(3_300);
    expect(validateScenario(s, LIMITS)).toHaveLength(0);
  });
});
