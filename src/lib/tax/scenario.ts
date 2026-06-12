/**
 * Contribution scenario modeling — pure, client-side friendly.
 *
 * Starting from current actuals (FederalTaxInputs built from book data),
 * applies hypothetical additional contributions, validates them against
 * remaining IRS limits, and computes the tax impact.
 */

import { computeFederalTax } from './federal';
import { computeStateTax } from './state';
import type {
  ContributionScenario,
  FederalTaxInputs,
  ScenarioContributionField,
  ScenarioResult,
  ScenarioValidationIssue,
  StateTaxInputs,
} from './types';
import { SCENARIO_CONTRIBUTION_FIELDS, SCENARIO_FIELD_LABELS } from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** IRS limit info per scenario field (already resolved for age/year) */
export interface ScenarioLimits {
  /** Total annual limit per field (employee deferral for 401k; null = unknown/unlimited) */
  limits: Record<ScenarioContributionField, number | null>;
  /** YTD actual contributions counted against each limit */
  actuals: Record<ScenarioContributionField, number>;
}

/**
 * 401k employee deferral limit is SHARED between traditional and Roth.
 * IRA limit is SHARED between traditional and Roth.
 */
const SHARED_LIMIT_GROUPS: ScenarioContributionField[][] = [
  ['trad401k', 'roth401k'],
  ['tradIra', 'rothIra'],
  ['hsa'],
];

function groupFor(field: ScenarioContributionField): ScenarioContributionField[] {
  return SHARED_LIMIT_GROUPS.find(g => g.includes(field)) ?? [field];
}

/** Remaining headroom for a field, accounting for shared limit groups. */
export function remainingHeadroom(
  field: ScenarioContributionField,
  limits: ScenarioLimits,
  additionalSoFar: Partial<Record<ScenarioContributionField, number>> = {},
): number | null {
  const group = groupFor(field);
  // Shared groups use one limit — take the max defined limit in the group
  const groupLimits = group
    .map(f => limits.limits[f])
    .filter((v): v is number => v !== null);
  if (groupLimits.length === 0) return null;
  const limit = Math.max(...groupLimits);
  const used = group.reduce(
    (sum, f) => sum + (limits.actuals[f] ?? 0) + (additionalSoFar[f] ?? 0),
    0,
  );
  return round2(limit - used);
}

export function validateScenario(
  scenario: ContributionScenario,
  limits: ScenarioLimits,
): ScenarioValidationIssue[] {
  const issues: ScenarioValidationIssue[] = [];
  // Validate per shared group so trad+roth combined cannot exceed the limit
  for (const group of SHARED_LIMIT_GROUPS) {
    const requested = group.reduce((sum, f) => sum + Math.max(0, scenario.additional[f] ?? 0), 0);
    if (requested <= 0) continue;
    const headroom = remainingHeadroom(group[0], limits);
    if (headroom === null) continue;
    if (requested > headroom + 0.005) {
      const primaryField = group.find(f => (scenario.additional[f] ?? 0) > 0) ?? group[0];
      issues.push({
        field: primaryField,
        requested: round2(requested),
        remaining: Math.max(0, headroom),
        message:
          `${group.map(f => SCENARIO_FIELD_LABELS[f]).join(' + ')} additional ` +
          `contributions of $${requested.toLocaleString()} exceed the remaining ` +
          `IRS headroom of $${Math.max(0, headroom).toLocaleString()}.`,
      });
    }
  }
  for (const field of SCENARIO_CONTRIBUTION_FIELDS) {
    if ((scenario.additional[field] ?? 0) < 0) {
      issues.push({
        field,
        requested: scenario.additional[field],
        remaining: 0,
        message: `${SCENARIO_FIELD_LABELS[field]} additional contribution cannot be negative.`,
      });
    }
  }
  return issues;
}

/** Apply a scenario's additional contributions to federal inputs. */
export function applyScenario(
  base: FederalTaxInputs,
  scenario: ContributionScenario,
): FederalTaxInputs {
  const add = scenario.additional;
  return {
    ...base,
    traditional401kContributions:
      base.traditional401kContributions + Math.max(0, add.trad401k ?? 0),
    traditionalIraContributions:
      base.traditionalIraContributions + Math.max(0, add.tradIra ?? 0),
    hsaContributions: base.hsaContributions + Math.max(0, add.hsa ?? 0),
    // Roth contributions don't change federal taxable income
  };
}

export interface EvaluateScenarioOptions {
  baseInputs: FederalTaxInputs;
  scenario: ContributionScenario;
  limits: ScenarioLimits;
  stateCode: string;
  stateFlatRateOverride?: number;
  /** Precomputed baseline liability (federal + state) for delta math */
  baselineLiability: number;
}

export function evaluateScenario(opts: EvaluateScenarioOptions): ScenarioResult {
  const issues = validateScenario(opts.scenario, opts.limits);
  const inputs = applyScenario(opts.baseInputs, opts.scenario);
  const federal = computeFederalTax(inputs);
  const stateInputs: StateTaxInputs = {
    year: inputs.year,
    filingStatus: inputs.filingStatus,
    federalAgi: federal.agi,
    flatRateOverride: opts.stateFlatRateOverride,
  };
  const state = computeStateTax(opts.stateCode, stateInputs);
  const totalLiability = round2(federal.totalTax + state.tax);
  const taxSaved = round2(opts.baselineLiability - totalLiability);
  const totalAdditional = SCENARIO_CONTRIBUTION_FIELDS.reduce(
    (sum, f) => sum + Math.max(0, opts.scenario.additional[f] ?? 0),
    0,
  );
  return {
    name: opts.scenario.name,
    valid: issues.length === 0,
    issues,
    federal,
    stateTax: state.tax,
    totalLiability,
    baselineLiability: round2(opts.baselineLiability),
    taxSaved,
    marginalRate: federal.marginalRate,
    effectiveRate: federal.effectiveRate,
    takeHomeChange: round2(taxSaved - totalAdditional),
    totalAdditional: round2(totalAdditional),
  };
}

/** Build a "max out" scenario for a single field from remaining headroom. */
export function maxOutScenario(
  field: ScenarioContributionField,
  name: string,
  limits: ScenarioLimits,
): ContributionScenario {
  const headroom = remainingHeadroom(field, limits);
  const additional: Record<ScenarioContributionField, number> = {
    trad401k: 0, roth401k: 0, tradIra: 0, rothIra: 0, hsa: 0,
  };
  additional[field] = Math.max(0, headroom ?? 0);
  return { name, additional };
}
