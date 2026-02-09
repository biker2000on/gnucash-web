import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { listSavedReports, createSavedReport } from '@/lib/reports/saved-reports';
import { ReportType } from '@/lib/reports/types';

/**
 * GET /api/reports/saved
 * List all saved reports for the current user
 */
export async function GET() {
    try {
        const user = await getCurrentUser();
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const reports = await listSavedReports(user.id);
        return NextResponse.json(reports);
    } catch (error) {
        console.error('Error listing saved reports:', error);
        return NextResponse.json({ error: 'Failed to list saved reports' }, { status: 500 });
    }
}

/**
 * POST /api/reports/saved
 * Create a new saved report
 */
export async function POST(request: NextRequest) {
    try {
        const user = await getCurrentUser();
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { name, baseReportType, description, config, filters, isStarred } = body;

        // Validate required fields
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return NextResponse.json({ error: 'name is required' }, { status: 400 });
        }
        if (!baseReportType || typeof baseReportType !== 'string') {
            return NextResponse.json({ error: 'baseReportType is required' }, { status: 400 });
        }

        const report = await createSavedReport(user.id, {
            name: name.trim(),
            baseReportType: baseReportType as ReportType,
            description,
            config: config || {},
            filters,
            isStarred,
        });

        return NextResponse.json(report, { status: 201 });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create saved report';
        console.error('Error creating saved report:', error);
        return NextResponse.json({ error: message }, { status: 400 });
    }
}
