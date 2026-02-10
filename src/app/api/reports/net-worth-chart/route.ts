import { NextRequest, NextResponse } from 'next/server';
import { ChartReportData, ReportType } from '@/lib/reports/types';

/**
 * Net Worth Chart Report API
 *
 * Proxies to dashboard/net-worth endpoint and transforms response
 * into ChartReportData shape for report viewer compatibility.
 */
export async function GET(request: NextRequest) {
    try {
        const searchParams = request.nextUrl.searchParams;
        const startDateParam = searchParams.get('startDate');
        const endDateParam = searchParams.get('endDate');

        // Build dashboard URL with same params
        const dashboardUrl = new URL('/api/dashboard/net-worth', request.nextUrl.origin);
        if (startDateParam) {
            dashboardUrl.searchParams.set('startDate', startDateParam);
        }
        if (endDateParam) {
            dashboardUrl.searchParams.set('endDate', endDateParam);
        }

        // Proxy to dashboard endpoint
        const response = await fetch(dashboardUrl.toString(), {
            headers: request.headers,
        });

        if (!response.ok) {
            throw new Error('Failed to fetch net worth data from dashboard');
        }

        const dashboardData = await response.json();

        // Transform to ChartReportData shape
        const reportData: ChartReportData = {
            type: ReportType.NET_WORTH_CHART,
            title: 'Net Worth Chart',
            generatedAt: new Date().toISOString(),
            filters: {
                startDate: startDateParam,
                endDate: endDateParam,
            },
            dataPoints: dashboardData.timeSeries || [],
            series: ['assets', 'liabilities', 'netWorth'],
        };

        return NextResponse.json(reportData);
    } catch (error) {
        console.error('Error generating net worth chart report:', error);
        return NextResponse.json(
            { error: 'Failed to generate report' },
            { status: 500 }
        );
    }
}
