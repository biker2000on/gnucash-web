import { NextRequest, NextResponse } from 'next/server';
import { ChartReportData, ReportType } from '@/lib/reports/types';
import { requireRole } from '@/lib/auth';
import { GET as dashboardIncomeExpense } from '@/app/api/dashboard/income-expense/route';

interface DashboardIncomeExpensePoint {
    month: string;
    income: number;
    expenses: number;
}

interface DashboardIncomeExpenseResponse {
    monthly: DashboardIncomeExpensePoint[];
}

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const searchParams = request.nextUrl.searchParams;

        // Call the dashboard handler in-process. Self-fetching
        // `request.nextUrl.origin` (derived from the client's Host header) while
        // forwarding Cookie would leak the session to a spoofed host.
        const dashboardUrl = new URL('/api/dashboard/income-expense', 'http://localhost');

        // Forward relevant params
        if (searchParams.has('startDate')) {
            dashboardUrl.searchParams.set('startDate', searchParams.get('startDate')!);
        }
        if (searchParams.has('endDate')) {
            dashboardUrl.searchParams.set('endDate', searchParams.get('endDate')!);
        }

        const response = await dashboardIncomeExpense(
            new NextRequest(dashboardUrl, request)
        );

        if (!response.ok) {
            return NextResponse.json(
                { error: 'Failed to fetch income/expense data' },
                { status: response.status }
            );
        }

        const dashboardData = await response.json() as DashboardIncomeExpenseResponse;

        // Transform to ChartReportData shape
        const chartData: ChartReportData = {
            type: ReportType.INCOME_EXPENSE_CHART,
            title: 'Income & Expense Chart',
            generatedAt: new Date().toISOString(),
            filters: {
                startDate: searchParams.get('startDate'),
                endDate: searchParams.get('endDate'),
            },
            series: ['income', 'expense'],
            dataPoints: dashboardData.monthly.map((m) => ({
                date: m.month,
                income: m.income,
                expense: m.expenses, // Note: dashboard uses 'expenses', we normalize to 'expense'
            })),
        };

        return NextResponse.json(chartData);
    } catch (error) {
        console.error('Error generating income/expense chart report:', error);
        return NextResponse.json(
            { error: 'Failed to generate report' },
            { status: 500 }
        );
    }
}
