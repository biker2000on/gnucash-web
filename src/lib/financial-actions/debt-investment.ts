import prisma from '@/lib/prisma';
import { PlannerSchema, PLANNER_ASSUMPTIONS, projectPlanner, STRATEGY_NAMES } from '@/lib/debt-investment-planner';
import { STRATEGIES } from '@/lib/debt-vs-invest';
import { createCalculationTrace } from '@/lib/provenance';
import type { FinancialActionCandidate } from './types';

export async function loadDebtInvestmentActions(userId: number, bookGuid: string): Promise<FinancialActionCandidate[]> {
  const saved = await prisma.gnucash_web_tool_config.findMany({ where: { user_id: userId, book_guid: bookGuid, tool_type: 'debt-vs-invest' }, orderBy: { updated_at: 'desc' }, take: 20 });
  return saved.flatMap(row => {
    const parsed = PlannerSchema.safeParse(row.config);
    if (!parsed.success) return [];
    const plans = STRATEGIES.map(k => projectPlanner(parsed.data, k));
    const unfunded = plans.some(p => p.final.shortfall > 0);
    const spread = Math.max(...plans.map(p => p.final.netWorth)) - Math.min(...plans.map(p => p.final.netWorth));
    const title = `Review debt strategy: ${row.name}`;
    const summary = unfunded ? 'This saved scenario contains unfunded payments or fees. Revise its budget before choosing a strategy.' : `Compare payoff, investing, and splitting over ${parsed.data.years} years using your saved assumptions.`;
    return [{
      stableKey: `debt-investment:${row.id}:${row.updated_at.toISOString()}`, lane: 'decide', origin: 'opportunity', sourceId: String(row.id), severity: unfunded ? 'warning' : 'info', title, summary, confidence: 0.6,
      operations: [{ id: 'review', label: 'Review comparison', kind: 'link', href: `/tools/debt-vs-invest?scenario=${row.id}`, primary: true }],
      trace: createCalculationTrace({ namespace: 'debt-investment', identity: { id: row.id, config: parsed.data }, title, summary, result: unfunded ? null : spread, unit: 'currency', assumptions: PLANNER_ASSUMPTIONS, warnings: ['Scenario estimates are not guaranteed returns.', ...(unfunded ? ['Funding shortfall makes this scenario infeasible.'] : [])], steps: plans.map(p => ({ key: p.strategy, label: STRATEGY_NAMES[p.strategy], inputs: { afterTaxInvestments: p.final.afterTaxInvestments, reserve: parsed.data.reserve, remainingDebt: p.final.debt, unfundedPayments: p.final.shortfall }, result: p.final.netWorth })), evidence: [{ kind: 'assumption', id: String(row.id), label: row.name, source: 'manual', observedAt: row.updated_at.toISOString(), href: `/tools/debt-vs-invest?scenario=${row.id}` }], metadata: { scenario: parsed.data } }),
      metadata: { scenarioId: row.id, toolType: 'debt-vs-invest' },
    } satisfies FinancialActionCandidate];
  });
}
