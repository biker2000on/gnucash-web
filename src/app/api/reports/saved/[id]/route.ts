import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getSavedReport, updateSavedReport, deleteSavedReport } from '@/lib/reports/saved-reports';

/**
 * GET /api/reports/saved/[id]
 * Get a single saved report by ID
 */
export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { id } = await params;
        const reportId = parseInt(id, 10);
        if (isNaN(reportId)) {
            return NextResponse.json({ error: 'Invalid report ID' }, { status: 400 });
        }

        const report = await getSavedReport(reportId, roleResult.user.id);
        if (!report) {
            return NextResponse.json({ error: 'Report not found' }, { status: 404 });
        }

        return NextResponse.json(report);
    } catch (error) {
        console.error('Error fetching saved report:', error);
        return NextResponse.json({ error: 'Failed to fetch saved report' }, { status: 500 });
    }
}

/**
 * PUT /api/reports/saved/[id]
 * Update an existing saved report
 */
export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { id } = await params;
        const reportId = parseInt(id, 10);
        if (isNaN(reportId)) {
            return NextResponse.json({ error: 'Invalid report ID' }, { status: 400 });
        }

        const body = await request.json();
        const { name, baseReportType, description, config, filters, isStarred } = body;

        const input: Record<string, unknown> = {};
        if (name !== undefined) input.name = name;
        if (baseReportType !== undefined) input.baseReportType = baseReportType;
        if (description !== undefined) input.description = description;
        if (config !== undefined) input.config = config;
        if (filters !== undefined) input.filters = filters;
        if (isStarred !== undefined) input.isStarred = isStarred;

        const report = await updateSavedReport(reportId, roleResult.user.id, input);
        if (!report) {
            return NextResponse.json({ error: 'Report not found' }, { status: 404 });
        }

        return NextResponse.json(report);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update saved report';
        console.error('Error updating saved report:', error);
        return NextResponse.json({ error: message }, { status: 400 });
    }
}

/**
 * DELETE /api/reports/saved/[id]
 * Delete a saved report
 */
export async function DELETE(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { id } = await params;
        const reportId = parseInt(id, 10);
        if (isNaN(reportId)) {
            return NextResponse.json({ error: 'Invalid report ID' }, { status: 400 });
        }

        const deleted = await deleteSavedReport(reportId, roleResult.user.id);
        if (!deleted) {
            return NextResponse.json({ error: 'Report not found' }, { status: 404 });
        }

        return new NextResponse(null, { status: 204 });
    } catch (error) {
        console.error('Error deleting saved report:', error);
        return NextResponse.json({ error: 'Failed to delete saved report' }, { status: 500 });
    }
}
