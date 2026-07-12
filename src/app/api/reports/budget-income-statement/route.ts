import { NextRequest, NextResponse } from 'next/server';
import {
    generateBudgetIncomeStatement,
    budgetBarchartSeries,
    type BarchartScope,
} from '@/lib/reports/budget-statements';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

/**
 * GET /api/reports/budget-income-statement
 *
 * Params:
 *   budget       (required) budget GUID; must belong to the active book
 *   periodStart  optional inclusive period index (default 0)
 *   periodEnd    optional inclusive period index (default last)
 *   series=1     return the grouped-barchart series instead of the statement
 *   scope        series only: 'income' | 'expense' | 'net' (default 'expense')
 *   scopeAccount series only: account GUID — chart that account's subtree
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const budgetGuid = searchParams.get('budget');
        if (!budgetGuid) {
            return NextResponse.json(
                { error: 'Missing required "budget" parameter' },
                { status: 400 }
            );
        }

        const bookAccountGuids = await getBookAccountGuids();

        const parseIndex = (name: string): number | null => {
            const raw = searchParams.get(name);
            if (raw === null || raw === '') return null;
            const value = parseInt(raw, 10);
            return Number.isNaN(value) ? null : value;
        };
        const periodStart = parseIndex('periodStart');
        const periodEnd = parseIndex('periodEnd');

        if (searchParams.get('series') === '1') {
            const scopeParam = searchParams.get('scope');
            const scope: BarchartScope =
                scopeParam === 'income' || scopeParam === 'net' ? scopeParam : 'expense';
            const series = await budgetBarchartSeries(bookAccountGuids, budgetGuid, {
                scope,
                accountGuid: searchParams.get('scopeAccount'),
                periodStart,
                periodEnd,
            });
            if (!series) {
                return NextResponse.json({ error: 'Budget not found' }, { status: 404 });
            }
            return NextResponse.json(series);
        }

        const report = await generateBudgetIncomeStatement(bookAccountGuids, budgetGuid, {
            periodStart,
            periodEnd,
        });
        if (!report) {
            return NextResponse.json({ error: 'Budget not found' }, { status: 404 });
        }
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating budget income statement:', error);
        return NextResponse.json(
            { error: 'Failed to generate budget income statement' },
            { status: 500 }
        );
    }
}
