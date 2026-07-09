import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import prisma from '@/lib/prisma';
import { BudgetService } from '@/lib/services/budget.service';
import {
    loadMonthlyActuals,
    generateFromHistory,
    applyTemplate,
    type GeneratedLine,
    type AllocationBucket,
} from '@/lib/budget-generator';

const GUID = z.string().length(32);

const GenerateSchema = z.object({
    /** Required when creating (preview=false). */
    name: z.string().min(1).max(2048).optional(),
    source: z.enum(['history', 'pct-of-income', 'zero-based']),
    /** Trailing complete months of history to look at. */
    months: z.number().int().min(1).max(60).default(12),
    statistic: z.enum(['median', 'mean']).default('median'),
    /** Round suggestions to the nearest multiple (dollars). */
    roundTo: z.number().min(0).max(1000).default(5),
    /** Default: all expense accounts with activity in the window. */
    accountGuids: z.array(GUID).max(500).optional(),
    includeIncome: z.boolean().default(false),
    numPeriods: z.number().int().min(1).max(60).default(12),
    /** YYYY-MM month of period 0; defaults to January of the current year. */
    startMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
    /** Return suggested lines without creating a budget. */
    preview: z.boolean().default(false),
    /** pct-of-income: override the income estimate derived from history. */
    monthlyIncome: z.number().min(0).optional(),
    /** pct-of-income: fractions per bucket (defaults to 50/30/20). */
    allocations: z
        .object({ needs: z.number().min(0).max(1), wants: z.number().min(0).max(1), savings: z.number().min(0).max(1) })
        .optional(),
    /**
     * Final lines to persist (create mode only). When provided — e.g. after
     * the user edited/excluded suggestions in the wizard preview — these are
     * used verbatim instead of regenerating from `source`.
     */
    lines: z.array(z.object({ accountGuid: GUID, amount: z.number().min(0) })).max(500).optional(),
});

const DEFAULT_ALLOCATIONS: Record<AllocationBucket, number> = { needs: 0.5, wants: 0.3, savings: 0.2 };

/**
 * @openapi
 * /api/budgets/generate:
 *   post:
 *     description: >
 *       Generate a budget from trailing history, a %-of-income template, or
 *       zero-based. With preview=true (body or query), returns suggested
 *       lines without creating anything; otherwise creates a real GnuCash
 *       budget (budget + monthly recurrence + amounts for all periods).
 *     responses:
 *       200:
 *         description: Preview lines.
 *       201:
 *         description: Budget created.
 *       400:
 *         description: Validation error.
 */
export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json();
        const parseResult = GenerateSchema.safeParse(body);
        if (!parseResult.success) {
            return NextResponse.json({ errors: parseResult.error.issues }, { status: 400 });
        }
        const input = parseResult.data;
        const preview = input.preview || request.nextUrl.searchParams.get('preview') === 'true';

        // When creating from explicit (wizard-edited) lines, skip generation.
        const needGeneration = preview || !input.lines;

        const loaded = needGeneration
            ? await loadMonthlyActuals({
                months: input.months,
                includeIncome: input.includeIncome,
                accountGuids: input.accountGuids,
            })
            : { monthKeys: [], accounts: [], monthlyIncomeEstimate: 0 };

        const monthlyIncome = input.monthlyIncome ?? loaded.monthlyIncomeEstimate;

        let lines: GeneratedLine[] = [];
        if (!needGeneration) {
            // lines stays empty; final lines come from input.lines below.
        } else if (input.source === 'zero-based') {
            lines = applyTemplate('zero-based', { accounts: loaded.accounts });
        } else if (input.source === 'pct-of-income') {
            // Allocate income percentages across EXPENSE accounts only;
            // income accounts (when included) keep their historical median.
            const expenseAccounts = loaded.accounts.filter(a => a.type === 'EXPENSE');
            const historyLines = generateFromHistory(loaded.accounts, {
                statistic: input.statistic,
                roundTo: input.roundTo,
            });
            const avgByGuid = new Map(historyLines.map(l => [l.accountGuid, l.avgMonthly]));
            lines = applyTemplate('pct-of-income', {
                monthlyIncome,
                allocations: input.allocations ?? DEFAULT_ALLOCATIONS,
                accounts: expenseAccounts.map(a => ({
                    guid: a.guid,
                    name: a.name,
                    fullname: a.fullname,
                    type: a.type,
                    avgMonthly: avgByGuid.get(a.guid) ?? 0,
                })),
                roundTo: input.roundTo,
            });
            if (input.includeIncome) {
                lines = [...historyLines.filter(l => l.type === 'INCOME'), ...lines];
            }
            lines.sort((a, b) => a.fullname.localeCompare(b.fullname));
        } else {
            lines = generateFromHistory(loaded.accounts, {
                statistic: input.statistic,
                roundTo: input.roundTo,
            });
        }

        if (preview) {
            return NextResponse.json({
                preview: true,
                source: input.source,
                months: input.months,
                monthKeys: loaded.monthKeys,
                statistic: input.statistic,
                roundTo: input.roundTo,
                monthlyIncome: input.source === 'pct-of-income' ? monthlyIncome : undefined,
                lines,
            });
        }

        // ---- Create mode ------------------------------------------------
        if (!input.name) {
            return NextResponse.json({ error: 'Name is required to create a budget' }, { status: 400 });
        }

        // Final lines: explicit (wizard-edited) lines win over generated ones.
        let finalLines: Array<{ accountGuid: string; name: string; amount: number }>;
        if (input.lines) {
            const bookGuids = new Set(await getBookAccountGuids());
            const outside = input.lines.filter(l => !bookGuids.has(l.accountGuid));
            if (outside.length > 0) {
                return NextResponse.json(
                    { error: `Accounts not in active book: ${outside.map(l => l.accountGuid).join(', ')}` },
                    { status: 400 }
                );
            }
            const named = await prisma.accounts.findMany({
                where: { guid: { in: input.lines.map(l => l.accountGuid) } },
                select: { guid: true, name: true },
            });
            const nameByGuid = new Map(named.map(a => [a.guid, a.name]));
            finalLines = input.lines.map(l => ({
                accountGuid: l.accountGuid,
                name: nameByGuid.get(l.accountGuid) ?? l.accountGuid,
                amount: l.amount,
            }));
        } else {
            finalLines = lines.map(l => ({ accountGuid: l.accountGuid, name: l.name, amount: l.amount }));
        }

        const startMonth = input.startMonth ?? `${new Date().getUTCFullYear()}-01`;
        const budget = await BudgetService.createWithAmounts({
            name: input.name,
            description: `Generated from ${input.source === 'history'
                ? `${input.months}-month history (${input.statistic})`
                : input.source === 'pct-of-income' ? '% of income template' : 'zero-based template'}`,
            num_periods: input.numPeriods,
            period_start: `${startMonth}-01`,
            lines: finalLines.map(l => ({
                accountGuid: l.accountGuid,
                amounts: new Array(input.numPeriods).fill(l.amount),
            })),
        }) as { guid: string };

        return NextResponse.json(
            {
                budgetGuid: budget.guid,
                lines: finalLines,
            },
            { status: 201 }
        );
    } catch (error) {
        console.error('Error generating budget:', error);
        if (error instanceof Error && error.message === 'NO_BOOKS') {
            return NextResponse.json({ error: 'No books available' }, { status: 400 });
        }
        if (error instanceof Error) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        return NextResponse.json({ error: 'Failed to generate budget' }, { status: 500 });
    }
}
