/**
 * Contribution scenario modeling — pure, client-side friendly.
 *
 * Starting from current actuals (FederalTaxInputs built from book data),
 * applies hypothetical additional contributions, validates them against
 * remaining IRS limits, and computes the tax impact.
 */

import { computeFederalTax } from './federal';
import { computeIraDeductionLimit } from './phaseouts';
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

/**
 * Deductibility context for hypothetical traditional-IRA additions
 * (IRC §219(g)). Without it, scenario IRA dollars are deducted in full —
 * which overstates savings for plan-covered filers above the MAGI range.
 */
export interface ScenarioIraDeductionContext {
  /** Filer is an active participant in an employer plan. */
  coveredByEmployerPlan: boolean;
  /** Spouse is an active participant in an employer plan. */
  spouseCoveredByEmployerPlan: boolean;
  /**
   * Household IRA contribution limit for the phase-out math (self + spouse
   * for joint filers). null = unknown → no cap applied.
   *
   * SIMPLIFICATION: joint filers get ONE phase-out pass using the filer's
   * coverage flags and the combined limit, not the per-spouse split the
   * estimator base computation does.
   */
  iraLimit: number | null;
  /**
   * UNCAPPED traditional IRA contributions already made (base actuals before
   * the base estimate's own §219(g) cap). Defaults to the base input value
   * (which may already be capped) when omitted.
   */
  baseTraditionalIraContributions?: number;
}

/**
 * Apply a scenario's additional contributions to federal inputs.
 *
 * When `iraDeduction` context is provided, hypothetical traditional-IRA
 * dollars are routed through computeIraDeductionLimit using MAGI computed
 * WITHOUT the IRA deduction (the same pass the estimator page does), so a
 * "max out traditional IRA" scenario for a plan-covered filer above the
 * MAGI range shows no phantom savings.
 */
export function applyScenario(
  base: FederalTaxInputs,
  scenario: ContributionScenario,
  iraDeduction?: ScenarioIraDeductionContext,
): FederalTaxInputs {
  const add = scenario.additional;
  const addTradIra = Math.max(0, add.tradIra ?? 0);
  const applied: FederalTaxInputs = {
    ...base,
    traditional401kContributions:
      base.traditional401kContributions + Math.max(0, add.trad401k ?? 0),
    traditionalIraContributions: base.traditionalIraContributions + addTradIra,
    hsaContributions: base.hsaContributions + Math.max(0, add.hsa ?? 0),
    // Roth contributions don't change federal taxable income
  };

  if (iraDeduction && iraDeduction.iraLimit !== null && applied.traditionalIraContributions > 0) {
    // MAGI for §219(g) is computed without the IRA deduction itself — the
    // scenario's other pre-tax additions (401k/HSA) DO lower it.
    const magiPass = computeFederalTax({ ...applied, traditionalIraContributions: 0 });
    const phaseOut = computeIraDeductionLimit({
      year: base.year,
      filingStatus: base.filingStatus,
      magi: magiPass.agi,
      coveredByEmployerPlan: iraDeduction.coveredByEmployerPlan,
      spouseCoveredByEmployerPlan: iraDeduction.spouseCoveredByEmployerPlan,
      iraLimit: iraDeduction.iraLimit,
    });
    const totalRequested =
      (iraDeduction.baseTraditionalIraContributions ?? base.traditionalIraContributions) +
      addTradIra;
    applied.traditionalIraContributions = round2(
      Math.min(totalRequested, phaseOut.deductibleLimit),
    );
  }

  return applied;
}

export interface EvaluateScenarioOptions {
  baseInputs: FederalTaxInputs;
  scenario: ContributionScenario;
  limits: ScenarioLimits;
  stateCode: string;
  stateFlatRateOverride?: number;
  /** Precomputed baseline liability (federal + state) for delta math */
  baselineLiability: number;
  /** §219(g) deductibility context for traditional-IRA additions. */
  iraDeduction?: ScenarioIraDeductionContext;
}

export function evaluateScenario(opts: EvaluateScenarioOptions): ScenarioResult {
  const issues = validateScenario(opts.scenario, opts.limits);
  const inputs = applyScenario(opts.baseInputs, opts.scenario, opts.iraDeduction);
  const addTradIra = Math.max(0, opts.scenario.additional.tradIra ?? 0);
  const requestedTradIra =
    (opts.iraDeduction?.baseTraditionalIraContributions ??
      opts.baseInputs.traditionalIraContributions) + addTradIra;
  const nonDeductibleTradIra = round2(
    Math.max(0, requestedTradIra - inputs.traditionalIraContributions),
  );
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
    nonDeductibleTradIra,
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
