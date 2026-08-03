import { NextRequest, NextResponse } from 'next/server';
import { ChartReportData, ReportType } from '@/lib/reports/types';
import { requireRole } from '@/lib/auth';
import { GET as dashboardNetWorth } from '@/app/api/dashboard/net-worth/route';

/**
 * Net Worth Chart Report API
 *
 * Proxies to dashboard/net-worth endpoint and transforms response
 * into ChartReportData shape for report viewer compatibility.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const searchParams = request.nextUrl.searchParams;
        const startDateParam = searchParams.get('startDate');
        const endDateParam = searchParams.get('endDate');

        // Call the dashboard handler in-process. This used to self-fetch
        // `request.nextUrl.origin` — built from the client-supplied Host header
        // — while forwarding every header including Cookie, so a spoofed Host
        // would have sent the caller's session cookie to that host.
        const dashboardUrl = new URL('/api/dashboard/net-worth', 'http://localhost');
        if (startDateParam) {
            dashboardUrl.searchParams.set('startDate', startDateParam);
        }
        if (endDateParam) {
            dashboardUrl.searchParams.set('endDate', endDateParam);
        }

        const response = await dashboardNetWorth(
            new NextRequest(dashboardUrl, request)
        );

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
