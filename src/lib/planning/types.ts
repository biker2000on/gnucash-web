import type {
  Scenario,
  ScenarioAssumptions,
  ScenarioBaseline,
  ScenarioRunResult,
} from '@/lib/scenario/types';

export const LIFE_EVENT_TYPES = [
  'job_change',
  'child',
  'move',
  'home_purchase',
  'rental',
  'sabbatical',
  'retirement',
  'education',
  'vehicle_replacement',
  'business_transition',
  'equity_vest',
  'custom',
] as const;
export type LifeEventType = (typeof LIFE_EVENT_TYPES)[number];

export interface LifeEvent {
  id: string;
  type: LifeEventType;
  title: string;
  date: string;
  cashImpact: number | null;
  notes: string | null;
}

export interface PlanGuardrails {
  minimumCash: number;
  debtPayoffBy: string | null;
  contributionPriority: string[];
  enforceGoalDeadlines: boolean;
}

export const DEFAULT_PLAN_GUARDRAILS: PlanGuardrails = {
  minimumCash: 10_000,
  debtPayoffBy: null,
  contributionPriority: ['employer_match', 'hsa', 'ira', '401k', 'taxable'],
  enforceGoalDeadlines: true,
};

export interface GuardrailResult {
  key: string;
  label: string;
  status: 'pass' | 'warning' | 'breach';
  detail: string;
}

export interface PlanVersion {
  version: number;
  scenario: Scenario;
  assumptions: ScenarioAssumptions;
  lifeEvents: LifeEvent[];
  guardrails: PlanGuardrails;
  baseline: ScenarioBaseline;
  projection: ScenarioRunResult;
  changeNote: string | null;
  createdAt: string;
}

export interface PlanReconciliation {
  id: number;
  period: string;
  actualBaseline: ScenarioBaseline;
  currentProjection: ScenarioRunResult;
  variances: Record<string, number | null>;
  causes: Array<{ key: string; label: string; amount: number; explanation: string }>;
  guardrailResults: GuardrailResult[];
  reconciledAt: string;
}

export interface PlanDecision {
  id: number;
  title: string;
  alternatives: string[];
  assumptions: string[];
  selectedAction: string;
  expectedImpact: string | null;
  actualOutcome: string | null;
  decidedAt: string;
  reviewedAt: string | null;
}

export interface LivingPlan {
  id: string;
  householdBookGuid: string;
  currency: string;
  name: string;
  status: 'adopted' | 'archived';
  currentVersion: number;
  adoptedAt: string;
  archivedAt: string | null;
  version: PlanVersion;
  reconciliations: PlanReconciliation[];
  decisions: PlanDecision[];
}
