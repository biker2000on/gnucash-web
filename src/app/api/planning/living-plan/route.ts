import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  addPlanDecision,
  adoptLivingPlan,
  archiveLivingPlan,
  getAdoptedLivingPlan,
  reconcileLivingPlan,
} from '@/lib/planning/living-plan';

function localPeriod(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export async function GET() {
  try {
    const auth = await requireRole('readonly');
    if (auth instanceof NextResponse) return auth;
    let plan = await getAdoptedLivingPlan(auth.user.id, auth.bookGuid);
    const currentPeriod = localPeriod(new Date());
    if (plan && plan.reconciliations[0]?.period !== currentPeriod) {
      plan = await reconcileLivingPlan(auth.user.id, auth.bookGuid);
    }
    return NextResponse.json({ plan });
  } catch (error) {
    console.error('Error loading living plan:', error);
    return NextResponse.json({ error: 'Failed to load living plan' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole('edit');
    if (auth instanceof NextResponse) return auth;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    const action = typeof body.action === 'string' ? body.action : 'adopt';

    if (action === 'reconcile') {
      return NextResponse.json({ plan: await reconcileLivingPlan(auth.user.id, auth.bookGuid) });
    }
    if (action === 'decision') {
      return NextResponse.json({
        plan: await addPlanDecision(auth.user.id, auth.bookGuid, body),
      }, { status: 201 });
    }
    if (action === 'archive') {
      await archiveLivingPlan(auth.user.id, auth.bookGuid);
      return NextResponse.json({ plan: null });
    }
    if (!body.scenario || typeof body.scenario !== 'object') {
      return NextResponse.json({ error: 'scenario is required' }, { status: 400 });
    }
    const plan = await adoptLivingPlan(auth.user.id, auth.bookGuid, {
      scenario: body.scenario,
      assumptions: body.assumptions as never,
      lifeEvents: body.lifeEvents,
      guardrails: body.guardrails,
      changeNote: typeof body.changeNote === 'string' ? body.changeNote : null,
    });
    return NextResponse.json({ plan }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update living plan';
    console.error('Error updating living plan:', error);
    const expected = message.includes('required') || message === 'No adopted living plan';
    return NextResponse.json(
      { error: expected ? message : 'Failed to update living plan' },
      { status: expected ? 400 : 500 },
    );
  }
}
