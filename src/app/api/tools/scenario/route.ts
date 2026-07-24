import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getPreference } from '@/lib/user-preferences';
import { buildScenarioBaseline } from '@/lib/scenario/data';
import { runScenario } from '@/lib/scenario/engine';
import {
    normalizeScenario,
    mergeScenarioAssumptions,
    SCENARIO_PREF_KEY,
    type SavedScenario,
    type ScenarioAssumptions,
} from '@/lib/scenario/types';

/**
 * @openapi
 * /api/tools/scenario:
 *   get:
 *     description: >
 *       Baseline prefill for the Scenario Sandbox — net worth, liquid balance,
 *       invested assets, trailing monthly cash flow, filing status, and state —
 *       plus the user's saved scenarios.
 *   post:
 *     description: >
 *       Runs one what-if scenario against the baseline and returns the
 *       side-by-side cash-flow, net-worth, tax, and FIRE comparisons.
 */

export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const userId = roleResult.user.id;

        const [baseline, savedScenarios] = await Promise.all([
            buildScenarioBaseline(userId, roleResult.bookGuid),
            getPreference<SavedScenario[]>(userId, SCENARIO_PREF_KEY, []),
        ]);

        return NextResponse.json({
            baseline,
            savedScenarios: Array.isArray(savedScenarios) ? savedScenarios : [],
        });
    } catch (error) {
        console.error('Error prefilling scenario sandbox:', error);
        return NextResponse.json(
            { error: 'Failed to load scenario baseline' },
            { status: 500 },
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const userId = roleResult.user.id;

        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
        }
        const payload = (body ?? {}) as {
            scenario?: unknown;
            assumptions?: Partial<ScenarioAssumptions> | null;
        };
        if (!payload.scenario || typeof payload.scenario !== 'object') {
            return NextResponse.json(
                { error: 'Request body must include a "scenario" object' },
                { status: 400 },
            );
        }

        const baseline = await buildScenarioBaseline(userId, roleResult.bookGuid);
        const scenario = normalizeScenario(payload.scenario, baseline.asOfDate);
        const assumptions = mergeScenarioAssumptions(payload.assumptions ?? null);
        const result = runScenario(baseline, scenario, assumptions);

        return NextResponse.json({ result, baseline });
    } catch (error) {
        console.error('Error running scenario:', error);
        return NextResponse.json(
            { error: 'Failed to run scenario' },
            { status: 500 },
        );
    }
}
