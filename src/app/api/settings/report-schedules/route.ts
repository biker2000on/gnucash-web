import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    listReportSchedules,
    createReportSchedule,
    isSchedulableReportType,
    SCHEDULE_CADENCES,
    SCHEDULABLE_REPORT_TYPES,
    type ReportSchedule,
    type ScheduleCadence,
} from '@/lib/report-scheduler';
import { getSavedReport } from '@/lib/reports/saved-reports';

function serialize(s: ReportSchedule) {
    return {
        id: s.id,
        savedReportId: s.savedReportId,
        baseReportType: s.baseReportType,
        config: s.config,
        cadence: s.cadence,
        anchorDay: s.anchorDay,
        recipients: s.recipients,
        enabled: s.enabled,
        lastRunAt: s.lastRunAt?.toISOString() ?? null,
        lastRunPeriod: s.lastRunPeriod,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
    };
}

/** GET /api/settings/report-schedules — list schedules for the current user + book. */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const schedules = await listReportSchedules(roleResult.user.id, roleResult.bookGuid);
        return NextResponse.json({
            schedules: schedules.map(serialize),
            reportTypes: SCHEDULABLE_REPORT_TYPES,
        });
    } catch (error) {
        console.error('Error listing report schedules:', error);
        return NextResponse.json({ error: 'Failed to list report schedules' }, { status: 500 });
    }
}

/** POST /api/settings/report-schedules — create a schedule. */
export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json();
        const savedReportId = body.savedReportId != null ? Number(body.savedReportId) : null;
        const baseReportType = typeof body.baseReportType === 'string' ? body.baseReportType : null;
        const cadence = body.cadence as ScheduleCadence;
        const anchorDay = Number(body.anchorDay);

        if (!SCHEDULE_CADENCES.includes(cadence)) {
            return NextResponse.json({ error: 'cadence must be weekly, monthly, or quarterly' }, { status: 400 });
        }
        if (!Number.isInteger(anchorDay)) {
            return NextResponse.json({ error: 'anchorDay must be an integer' }, { status: 400 });
        }

        if (savedReportId != null) {
            if (!Number.isInteger(savedReportId)) {
                return NextResponse.json({ error: 'savedReportId must be an integer' }, { status: 400 });
            }
            const saved = await getSavedReport(savedReportId, roleResult.user.id);
            if (!saved) {
                return NextResponse.json({ error: 'Saved report not found' }, { status: 404 });
            }
            if (!isSchedulableReportType(saved.baseReportType)) {
                return NextResponse.json(
                    { error: `Saved report type ${saved.baseReportType} is not schedulable yet` },
                    { status: 400 },
                );
            }
        } else if (!isSchedulableReportType(baseReportType)) {
            return NextResponse.json(
                { error: 'Either savedReportId or a supported baseReportType is required' },
                { status: 400 },
            );
        }

        const schedule = await createReportSchedule(roleResult.user.id, roleResult.bookGuid, {
            savedReportId,
            baseReportType: savedReportId != null ? null : baseReportType,
            config: body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {},
            cadence,
            anchorDay,
            recipients: typeof body.recipients === 'string' ? body.recipients : null,
            enabled: body.enabled !== false,
        });

        return NextResponse.json({ schedule: serialize(schedule) }, { status: 201 });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create report schedule';
        const isValidation = /invalid|required|unsupported/i.test(message);
        console.error('Error creating report schedule:', error);
        return NextResponse.json(
            { error: isValidation ? message : 'Failed to create report schedule' },
            { status: isValidation ? 400 : 500 },
        );
    }
}
