import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';
import { applyScenario } from '@/lib/budget-generator';
import { BudgetService } from '@/lib/services/budget.service';

const ScenarioSchema = z.object({
    name: z.string().min(1).max(2048),
    /** Scale factor: lean 0.9, stretch 1.1, or custom. */
    factor: z.number().min(0.01).max(10),
});

/**
 * @openapi
 * /api/budgets/{guid}/scenario:
 *   post:
 *     description: >
 *       Duplicate an existing budget as a scenario, scaling every per-period
 *       amount by the given factor (rounded to cents). Copies num_periods
 *       and the recurrence start.
 *     responses:
 *       201:
 *         description: Scenario budget created; returns { budgetGuid }.
 *       404:
 *         description: Source budget not found.
 */
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        const body = await request.json();
        const parseResult = ScenarioSchema.safeParse(body);
        if (!parseResult.success) {
            return NextResponse.json({ errors: parseResult.error.issues }, { status: 400 });
        }
        const { name, factor } = parseResult.data;

        const source = await prisma.budgets.findUnique({
            where: { guid },
            include: { recurrences: true, amounts: true },
        });
        if (!source) {
            return NextResponse.json({ error: 'Budget not found' }, { status: 404 });
        }

        // Per-account per-period matrices from the source budget.
        const matrices = new Map<string, number[]>();
        for (const amt of source.amounts) {
            if (amt.period_num < 0 || amt.period_num >= source.num_periods) continue;
            let row = matrices.get(amt.account_guid);
            if (!row) {
                row = new Array(source.num_periods).fill(0);
                matrices.set(amt.account_guid, row);
            }
            row[amt.period_num] += toDecimalNumber(amt.amount_num, amt.amount_denom);
        }

        const recurrence = source.recurrences?.[0] ?? null;
        const periodStart = recurrence
            ? recurrence.recurrence_period_start.toISOString().slice(0, 10)
            : undefined;

        const pct = Math.round((factor - 1) * 100);
        const budget = await BudgetService.createWithAmounts({
            name,
            description: `Scenario of "${source.name}" (${pct >= 0 ? '+' : ''}${pct}%)`,
            num_periods: source.num_periods,
            period_start: periodStart,
            lines: [...matrices.entries()].map(([accountGuid, amounts]) => ({
                accountGuid,
                amounts: applyScenario(amounts, factor),
            })),
        }) as { guid: string };

        return NextResponse.json({ budgetGuid: budget.guid }, { status: 201 });
    } catch (error) {
        console.error('Error creating budget scenario:', error);
        if (error instanceof Error) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        return NextResponse.json({ error: 'Failed to create scenario' }, { status: 500 });
    }
}
