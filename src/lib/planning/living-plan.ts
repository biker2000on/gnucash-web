import { randomUUID } from 'node:crypto';
import prisma from '@/lib/prisma';
import { getBaseCurrencyForBook } from '@/lib/currency';
import { buildScenarioBaseline } from '@/lib/scenario/data';
import { runScenario } from '@/lib/scenario/engine';
import {
  mergeScenarioAssumptions,
  normalizeScenario,
  type Scenario,
  type ScenarioAssumptions,
  type ScenarioBaseline,
  type ScenarioRunResult,
} from '@/lib/scenario/types';
import { listGoals } from '@/lib/services/goal.service';
import {
  DEFAULT_PLAN_GUARDRAILS,
  LIFE_EVENT_TYPES,
  type GuardrailResult,
  type LifeEvent,
  type LifeEventType,
  type LivingPlan,
  type PlanDecision,
  type PlanGuardrails,
  type PlanReconciliation,
  type PlanVersion,
} from './types';

export * from './types';

type PlanRow = {
  id: string;
  household_book_guid: string;
  name: string;
  status: string;
  current_version: number;
  adopted_at: Date;
  archived_at: Date | null;
  version: number;
  scenario: unknown;
  assumptions: unknown;
  life_events: unknown;
  guardrails: unknown;
  baseline: unknown;
  projection: unknown;
  change_note: string | null;
  version_created_at: Date;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizeLifeEvents(value: unknown): LifeEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): LifeEvent[] => {
    const item = asObject(raw);
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const date = typeof item.date === 'string' ? item.date : '';
    const type = typeof item.type === 'string' && (LIFE_EVENT_TYPES as readonly string[]).includes(item.type)
      ? item.type as LifeEventType
      : 'custom';
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    return [{
      id: typeof item.id === 'string' && item.id ? item.id : randomUUID(),
      type,
      title,
      date,
      cashImpact: typeof item.cashImpact === 'number' && Number.isFinite(item.cashImpact)
        ? Math.round(item.cashImpact * 100) / 100
        : null,
      notes: typeof item.notes === 'string' && item.notes.trim() ? item.notes.trim() : null,
    }];
  });
}

export function normalizeGuardrails(value: unknown): PlanGuardrails {
  const raw = asObject(value);
  const minimumCash = typeof raw.minimumCash === 'number' && Number.isFinite(raw.minimumCash)
    ? Math.max(0, raw.minimumCash)
    : DEFAULT_PLAN_GUARDRAILS.minimumCash;
  return {
    minimumCash,
    debtPayoffBy: typeof raw.debtPayoffBy === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.debtPayoffBy)
      ? raw.debtPayoffBy
      : null,
    contributionPriority: Array.isArray(raw.contributionPriority)
      ? raw.contributionPriority.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : [...DEFAULT_PLAN_GUARDRAILS.contributionPriority],
    enforceGoalDeadlines: raw.enforceGoalDeadlines !== false,
  };
}

export function attributePlanVariance(
  planned: ScenarioBaseline,
  actual: ScenarioBaseline,
): Array<{ key: string; label: string; amount: number; explanation: string }> {
  const candidates = [
    {
      key: 'income',
      label: 'Income run rate',
      amount: (actual.monthlyIncome - planned.monthlyIncome) * 12,
      explanation: 'Trailing annualized income moved versus the adopted baseline.',
    },
    {
      key: 'spending',
      label: 'Spending run rate',
      amount: (planned.monthlyExpenses - actual.monthlyExpenses) * 12,
      explanation: 'Lower spending is positive; higher spending is negative.',
    },
    {
      key: 'market',
      label: 'Investments and markets',
      amount: actual.investedAssets - planned.investedAssets,
      explanation: 'Current marked investment value changed versus adoption.',
    },
    {
      key: 'liquidity',
      label: 'Liquid cash',
      amount: actual.liquidBalance - planned.liquidBalance,
      explanation: 'Bank and cash balances changed versus the plan baseline.',
    },
  ];
  return candidates
    .filter(cause => Math.abs(cause.amount) >= 1)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .map(cause => ({ ...cause, amount: Math.round(cause.amount * 100) / 100 }));
}

export async function evaluateGuardrails(
  bookGuid: string,
  baseline: ScenarioBaseline,
  projection: ScenarioRunResult,
  guardrails: PlanGuardrails,
): Promise<GuardrailResult[]> {
  const results: GuardrailResult[] = [{
    key: 'minimum_cash',
    label: 'Minimum cash',
    status: baseline.liquidBalance < guardrails.minimumCash
      ? 'breach'
      : projection.cashFlow.firstNegativeMonth
        ? 'warning'
        : 'pass',
    detail: baseline.liquidBalance < guardrails.minimumCash
      ? `Current cash is below the ${guardrails.minimumCash.toFixed(0)} guardrail.`
      : projection.cashFlow.firstNegativeMonth
        ? `The plan projects negative cash in ${projection.cashFlow.firstNegativeMonth}.`
        : `Current and projected liquidity remain above the guardrail.`,
  }];

  const goals = await listGoals(bookGuid).catch(() => []);
  const overdueGoals = goals.filter(goal => goal.targetDate && goal.targetDate < baseline.asOfDate);
  results.push({
    key: 'goal_deadlines',
    label: 'Goal deadlines',
    status: guardrails.enforceGoalDeadlines && overdueGoals.length > 0 ? 'breach' : 'pass',
    detail: overdueGoals.length > 0
      ? `${overdueGoals.length} goal deadline${overdueGoals.length === 1 ? '' : 's'} passed without a plan update.`
      : `${goals.length} tracked goal${goals.length === 1 ? '' : 's'} remain within their configured deadlines.`,
  });

  results.push({
    key: 'debt_payoff',
    label: 'Debt payoff',
    status: guardrails.debtPayoffBy && projection.loans.some(loan => {
      const end = new Date(`${baseline.asOfDate}T00:00:00Z`);
      end.setUTCMonth(end.getUTCMonth() + loan.termMonths);
      return end.toISOString().slice(0, 10) > guardrails.debtPayoffBy!;
    }) ? 'warning' : 'pass',
    detail: guardrails.debtPayoffBy
      ? `New plan debt is checked against payoff by ${guardrails.debtPayoffBy}.`
      : 'No household debt payoff deadline is configured.',
  });

  results.push({
    key: 'contribution_priority',
    label: 'Contribution priority',
    status: guardrails.contributionPriority.length === 0 ? 'warning' : 'pass',
    detail: guardrails.contributionPriority.length > 0
      ? `Priority: ${guardrails.contributionPriority.join(' → ')}.`
      : 'Add a contribution funding priority.',
  });
  return results;
}

function mapVersion(row: PlanRow): PlanVersion {
  return {
    version: row.version,
    scenario: row.scenario as Scenario,
    assumptions: mergeScenarioAssumptions(row.assumptions as Partial<ScenarioAssumptions>),
    lifeEvents: normalizeLifeEvents(row.life_events),
    guardrails: normalizeGuardrails(row.guardrails),
    baseline: row.baseline as ScenarioBaseline,
    projection: row.projection as ScenarioRunResult,
    changeNote: row.change_note,
    createdAt: row.version_created_at.toISOString(),
  };
}

async function loadReconciliations(planId: string): Promise<PlanReconciliation[]> {
  type Row = {
    id: bigint;
    period: string;
    actual_baseline: unknown;
    current_projection: unknown;
    variances: unknown;
    causes: unknown;
    guardrail_results: unknown;
    reconciled_at: Date;
  };
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id, period, actual_baseline, current_projection, variances, causes,
           guardrail_results, reconciled_at
    FROM gnucash_web_living_plan_reconciliations
    WHERE plan_id = ${planId}
    ORDER BY period DESC
    LIMIT 24
  `;
  return rows.map(row => ({
    id: Number(row.id),
    period: row.period,
    actualBaseline: row.actual_baseline as ScenarioBaseline,
    currentProjection: row.current_projection as ScenarioRunResult,
    variances: asObject(row.variances) as Record<string, number | null>,
    causes: Array.isArray(row.causes) ? row.causes as PlanReconciliation['causes'] : [],
    guardrailResults: Array.isArray(row.guardrail_results)
      ? row.guardrail_results as GuardrailResult[]
      : [],
    reconciledAt: row.reconciled_at.toISOString(),
  }));
}

async function loadDecisions(planId: string): Promise<PlanDecision[]> {
  type Row = {
    id: bigint;
    title: string;
    alternatives: unknown;
    assumptions: unknown;
    selected_action: string;
    expected_impact: string | null;
    actual_outcome: string | null;
    decided_at: Date;
    reviewed_at: Date | null;
  };
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id, title, alternatives, assumptions, selected_action,
           expected_impact, actual_outcome, decided_at, reviewed_at
    FROM gnucash_web_living_plan_decisions
    WHERE plan_id = ${planId}
    ORDER BY decided_at DESC
    LIMIT 100
  `;
  return rows.map(row => ({
    id: Number(row.id),
    title: row.title,
    alternatives: Array.isArray(row.alternatives) ? row.alternatives.filter((v): v is string => typeof v === 'string') : [],
    assumptions: Array.isArray(row.assumptions) ? row.assumptions.filter((v): v is string => typeof v === 'string') : [],
    selectedAction: row.selected_action,
    expectedImpact: row.expected_impact,
    actualOutcome: row.actual_outcome,
    decidedAt: row.decided_at.toISOString(),
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
  }));
}

export async function getAdoptedLivingPlan(
  userId: number,
  bookGuid: string,
): Promise<LivingPlan | null> {
  const rows = await prisma.$queryRaw<PlanRow[]>`
    SELECT p.id, p.household_book_guid, p.name, p.status, p.current_version,
           p.adopted_at, p.archived_at, v.version, v.scenario, v.assumptions,
           v.life_events, v.guardrails, v.baseline, v.projection, v.change_note,
           v.created_at AS version_created_at
    FROM gnucash_web_living_plans p
    JOIN gnucash_web_living_plan_versions v
      ON v.plan_id = p.id AND v.version = p.current_version
    WHERE p.user_id = ${userId}
      AND p.household_book_guid = ${bookGuid}
      AND p.status = 'adopted'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const [reconciliations, decisions, currency] = await Promise.all([
    loadReconciliations(row.id),
    loadDecisions(row.id),
    getBaseCurrencyForBook(bookGuid),
  ]);
  return {
    id: row.id,
    householdBookGuid: row.household_book_guid,
    currency: currency?.mnemonic ?? 'UNKNOWN',
    name: row.name,
    status: row.status === 'archived' ? 'archived' : 'adopted',
    currentVersion: row.current_version,
    adoptedAt: row.adopted_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
    version: mapVersion(row),
    reconciliations,
    decisions,
  };
}

export interface AdoptPlanInput {
  scenario: unknown;
  assumptions?: Partial<ScenarioAssumptions> | null;
  lifeEvents?: unknown;
  guardrails?: unknown;
  changeNote?: string | null;
}

export async function adoptLivingPlan(
  userId: number,
  bookGuid: string,
  input: AdoptPlanInput,
): Promise<LivingPlan> {
  const baseline = await buildScenarioBaseline(userId, bookGuid);
  const scenario = normalizeScenario(input.scenario, baseline.asOfDate);
  const assumptions = mergeScenarioAssumptions(input.assumptions);
  const lifeEvents = normalizeLifeEvents(input.lifeEvents);
  const guardrails = normalizeGuardrails(input.guardrails);
  const projection = runScenario(baseline, scenario, assumptions);
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(${userId}::integer, hashtext(${bookGuid}))
    `;
    type LockedPlan = { id: string; current_version: number };
    const locked = await tx.$queryRaw<LockedPlan[]>`
      SELECT id, current_version
      FROM gnucash_web_living_plans
      WHERE user_id = ${userId}
        AND household_book_guid = ${bookGuid}
        AND status = 'adopted'
      FOR UPDATE
    `;
    const existing = locked[0];
    if (existing) {
      const nextVersion = existing.current_version + 1;
      await tx.$executeRaw`
        INSERT INTO gnucash_web_living_plan_versions
          (plan_id, version, scenario, assumptions, life_events, guardrails,
           baseline, projection, change_note, created_by)
        VALUES (
          ${existing.id}, ${nextVersion}, ${JSON.stringify(scenario)}::jsonb,
          ${JSON.stringify(assumptions)}::jsonb, ${JSON.stringify(lifeEvents)}::jsonb,
          ${JSON.stringify(guardrails)}::jsonb, ${JSON.stringify(baseline)}::jsonb,
          ${JSON.stringify(projection)}::jsonb, ${input.changeNote?.trim() || 'Updated adopted plan'},
          ${userId}
        )
      `;
      await tx.$executeRaw`
        UPDATE gnucash_web_living_plans
        SET name = ${scenario.name}, current_version = ${nextVersion}, updated_at = NOW()
        WHERE id = ${existing.id}
          AND user_id = ${userId}
          AND current_version = ${existing.current_version}
      `;
    } else {
      const id = randomUUID();
      await tx.$executeRaw`
        INSERT INTO gnucash_web_living_plans
          (id, user_id, household_book_guid, name, status, current_version)
        VALUES (${id}, ${userId}, ${bookGuid}, ${scenario.name}, 'adopted', 1)
      `;
      await tx.$executeRaw`
        INSERT INTO gnucash_web_living_plan_versions
          (plan_id, version, scenario, assumptions, life_events, guardrails,
           baseline, projection, change_note, created_by)
        VALUES (
          ${id}, 1, ${JSON.stringify(scenario)}::jsonb, ${JSON.stringify(assumptions)}::jsonb,
          ${JSON.stringify(lifeEvents)}::jsonb, ${JSON.stringify(guardrails)}::jsonb,
          ${JSON.stringify(baseline)}::jsonb, ${JSON.stringify(projection)}::jsonb,
          ${input.changeNote?.trim() || 'Adopted from Scenario Sandbox'}, ${userId}
        )
      `;
    }
  });
  return (await getAdoptedLivingPlan(userId, bookGuid))!;
}

export async function reconcileLivingPlan(
  userId: number,
  bookGuid: string,
): Promise<LivingPlan> {
  const plan = await getAdoptedLivingPlan(userId, bookGuid);
  if (!plan) throw new Error('No adopted living plan');
  const actual = await buildScenarioBaseline(userId, bookGuid);
  const currentProjection = runScenario(actual, plan.version.scenario, plan.version.assumptions);
  const causes = attributePlanVariance(plan.version.baseline, actual);
  const guardrailResults = await evaluateGuardrails(bookGuid, actual, currentProjection, plan.version.guardrails);
  const variances = {
    netWorth: actual.netWorth - plan.version.baseline.netWorth,
    liquidBalance: actual.liquidBalance - plan.version.baseline.liquidBalance,
    annualIncomeRunRate: (actual.monthlyIncome - plan.version.baseline.monthlyIncome) * 12,
    annualExpenseRunRate: (actual.monthlyExpenses - plan.version.baseline.monthlyExpenses) * 12,
    endingNetWorth: currentProjection.netWorth.endingScenario - plan.version.projection.netWorth.endingScenario,
    annualTax: currentProjection.tax.steadyStateAnnualDelta - plan.version.projection.tax.steadyStateAnnualDelta,
    fireShiftYears: currentProjection.fire.shiftYears === null || plan.version.projection.fire.shiftYears === null
      ? null
      : currentProjection.fire.shiftYears - plan.version.projection.fire.shiftYears,
  };
  const period = actual.asOfDate.slice(0, 7);
  await prisma.$executeRaw`
    INSERT INTO gnucash_web_living_plan_reconciliations
      (plan_id, version, period, actual_baseline, current_projection, variances,
       causes, guardrail_results, reconciled_at)
    VALUES (
      ${plan.id}, ${plan.currentVersion}, ${period}, ${JSON.stringify(actual)}::jsonb,
      ${JSON.stringify(currentProjection)}::jsonb, ${JSON.stringify(variances)}::jsonb,
      ${JSON.stringify(causes)}::jsonb, ${JSON.stringify(guardrailResults)}::jsonb, NOW()
    )
    ON CONFLICT (plan_id, period) DO UPDATE SET
      version = EXCLUDED.version,
      actual_baseline = EXCLUDED.actual_baseline,
      current_projection = EXCLUDED.current_projection,
      variances = EXCLUDED.variances,
      causes = EXCLUDED.causes,
      guardrail_results = EXCLUDED.guardrail_results,
      reconciled_at = NOW()
  `;
  return (await getAdoptedLivingPlan(userId, bookGuid))!;
}

export async function addPlanDecision(
  userId: number,
  bookGuid: string,
  input: Record<string, unknown>,
): Promise<LivingPlan> {
  const plan = await getAdoptedLivingPlan(userId, bookGuid);
  if (!plan) throw new Error('No adopted living plan');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const selectedAction = typeof input.selectedAction === 'string' ? input.selectedAction.trim() : '';
  if (!title || !selectedAction) throw new Error('Decision title and selected action are required');
  const stringArray = (value: unknown) => Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim())
    : [];
  await prisma.$executeRaw`
    INSERT INTO gnucash_web_living_plan_decisions
      (plan_id, title, alternatives, assumptions, selected_action, expected_impact, actual_outcome)
    VALUES (
      ${plan.id}, ${title}, ${JSON.stringify(stringArray(input.alternatives))}::jsonb,
      ${JSON.stringify(stringArray(input.assumptions))}::jsonb, ${selectedAction},
      ${typeof input.expectedImpact === 'string' ? input.expectedImpact.trim() || null : null},
      ${typeof input.actualOutcome === 'string' ? input.actualOutcome.trim() || null : null}
    )
  `;
  return (await getAdoptedLivingPlan(userId, bookGuid))!;
}

export async function archiveLivingPlan(
  userId: number,
  bookGuid: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE gnucash_web_living_plans
    SET status = 'archived', archived_at = NOW(), updated_at = NOW()
    WHERE user_id = ${userId} AND household_book_guid = ${bookGuid} AND status = 'adopted'
  `;
}
