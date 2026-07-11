import { NextRequest, NextResponse } from 'next/server';
import { generateBudgetReport } from '@/lib/reports/budget-report';
import { ReportFilters } from '@/lib/reports/types';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

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

        const filters: ReportFilters = {
            startDate: searchParams.get('startDate'),
            endDate: searchParams.get('endDate'),
            bookAccountGuids,
        };

        const report = await generateBudgetReport(budgetGuid, filters);
        if (!report) {
            return NextResponse.json({ error: 'Budget not found' }, { status: 404 });
        }
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating budget report:', error);
        return NextResponse.json(
            { error: 'Failed to generate budget report' },
            { status: 500 }
        );
    }
}
