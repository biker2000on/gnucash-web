import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { ToolConfigService } from '@/lib/services/tool-config.service';
import { addPlanDecision } from '@/lib/planning/living-plan';
import { PlannerSchema, PLANNER_ASSUMPTIONS, projectPlanner, STRATEGY_NAMES } from '@/lib/debt-investment-planner';
import { STRATEGIES } from '@/lib/debt-vs-invest';

const Input = z.object({ scenarioId: z.number().int().positive(), strategy: z.enum(['payoff', 'invest', 'split']), scenario: PlannerSchema });
export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole('edit');
    if (auth instanceof NextResponse) return auth;
    const parsed = Input.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'A saved scenario and valid strategy are required.' }, { status: 400 });
    const { scenarioId, strategy, scenario } = parsed.data;
    const saved = await ToolConfigService.getById(scenarioId, auth.user.id, auth.bookGuid);
    if (!saved || saved.tool_type !== 'debt-vs-invest') return NextResponse.json({ error: 'Saved scenario not found in this book.' }, { status: 404 });
    const stored = PlannerSchema.safeParse(saved.config);
    if (!stored.success || JSON.stringify(stored.data) !== JSON.stringify(scenario)) return NextResponse.json({ error: 'Save your current inputs before recording this decision.' }, { status: 409 });
    const plans = STRATEGIES.map(k => projectPlanner(scenario, k));
    if (plans.some(p => p.final.shortfall > 0)) return NextResponse.json({ error: 'Resolve unfunded payments before recording this decision.' }, { status: 400 });
    const selected = plans.find(p => p.strategy === strategy)!;
    const baseline = plans.find(p => p.strategy === 'invest')!;
    const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
    const plan = await addPlanDecision(auth.user.id, auth.bookGuid, {
      title: `Debt or invest: ${saved.name}`,
      selectedAction: STRATEGY_NAMES[strategy],
      alternatives: STRATEGIES.filter(k => k !== strategy).map(k => STRATEGY_NAMES[k]),
      assumptions: [...PLANNER_ASSUMPTIONS, `Saved scenario ${scenarioId}, version ${saved.updated_at.toISOString()}.`, `Input snapshot: ${JSON.stringify(scenario)}`],
      expectedImpact: `At year ${scenario.years}: ${money(selected.final.netWorth)} after-tax investments plus protected cash minus debt; ${money(selected.final.netWorth - baseline.final.netWorth)} versus investing. Debt-free month: ${selected.payoffMonth ?? 'beyond horizon'}. Independence threshold month: ${selected.financialIndependenceMonth ?? 'beyond horizon'}. This decision does not replace the Living Plan forecast or execute transactions.`,
    });
    return NextResponse.json({ plan }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === 'No adopted living plan') return NextResponse.json({ error: 'Adopt a Living Plan before recording a debt strategy.' }, { status: 400 });
    console.error('Failed to record debt strategy:', error);
    return NextResponse.json({ error: 'Failed to record debt strategy.' }, { status: 500 });
  }
}
