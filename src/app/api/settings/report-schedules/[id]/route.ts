import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    getReportSchedule,
    updateReportSchedule,
    deleteReportSchedule,
    runReportSchedule,
    isSchedulableReportType,
    SCHEDULE_CADENCES,
    type ReportSchedule,
    type ReportScheduleInput,
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

async function parseId(params: Promise<{ id: string }>): Promise<number | null> {
    const { id: idParam } = await params;
    const id = parseInt(idParam, 10);
    return Number.isInteger(id) ? id : null;
}

/** PATCH /api/settings/report-schedules/[id] — update a schedule (incl. enable toggle). */
export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const id = await parseId(params);
        if (id === null) return NextResponse.json({ error: 'Invalid schedule id' }, { status: 400 });

        const body = await request.json();
        const patch: Partial<ReportScheduleInput> = {};

        if (body.savedReportId !== undefined) {
            const savedReportId = body.savedReportId != null ? Number(body.savedReportId) : null;
            if (savedReportId != null) {
                if (!Number.isInteger(savedReportId)) {
                    return NextResponse.json({ error: 'savedReportId must be an integer' }, { status: 400 });
                }
                const saved = await getSavedReport(savedReportId, roleResult.user.id, roleResult.bookGuid);
                if (!saved) return NextResponse.json({ error: 'Saved report not found' }, { status: 404 });
                if (!isSchedulableReportType(saved.baseReportType)) {
                    return NextResponse.json(
                        { error: `Saved report type ${saved.baseReportType} is not schedulable yet` },
                        { status: 400 },
                    );
                }
            }
            patch.savedReportId = savedReportId;
        }
        if (body.baseReportType !== undefined) {
            patch.baseReportType = typeof body.baseReportType === 'string' ? body.baseReportType : null;
        }
        if (body.config !== undefined) {
            patch.config = body.config && typeof body.config === 'object' && !Array.isArray(body.config)
                ? body.config
                : {};
        }
        if (body.cadence !== undefined) {
            if (!SCHEDULE_CADENCES.includes(body.cadence as ScheduleCadence)) {
                return NextResponse.json({ error: 'cadence must be weekly, monthly, or quarterly' }, { status: 400 });
            }
            patch.cadence = body.cadence;
        }
        if (body.anchorDay !== undefined) {
            const anchorDay = Number(body.anchorDay);
            if (!Number.isInteger(anchorDay)) {
                return NextResponse.json({ error: 'anchorDay must be an integer' }, { status: 400 });
            }
            patch.anchorDay = anchorDay;
        }
        if (body.recipients !== undefined) {
            patch.recipients = typeof body.recipients === 'string' ? body.recipients : null;
        }
        if (body.enabled !== undefined) {
            patch.enabled = body.enabled === true;
        }

        const updated = await updateReportSchedule(id, roleResult.user.id, patch);
        if (!updated) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });

        return NextResponse.json({ schedule: serialize(updated) });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update report schedule';
        const isValidation = /invalid|required|unsupported/i.test(message);
        console.error('Error updating report schedule:', error);
        return NextResponse.json(
            { error: isValidation ? message : 'Failed to update report schedule' },
            { status: isValidation ? 400 : 500 },
        );
    }
}

/** POST /api/settings/report-schedules/[id] — run this schedule now (forced). */
export async function POST(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const id = await parseId(params);
        if (id === null) return NextResponse.json({ error: 'Invalid schedule id' }, { status: 400 });

        const schedule = await getReportSchedule(id, roleResult.user.id);
        if (!schedule) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });

        const result = await runReportSchedule(schedule, { force: true });
        return NextResponse.json({ result });
    } catch (error) {
        console.error('Error running report schedule:', error);
        return NextResponse.json({ error: 'Failed to run report schedule' }, { status: 500 });
    }
}

/** DELETE /api/settings/report-schedules/[id] — delete a schedule. */
export async function DELETE(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const id = await parseId(params);
        if (id === null) return NextResponse.json({ error: 'Invalid schedule id' }, { status: 400 });

        const deleted = await deleteReportSchedule(id, roleResult.user.id);
        if (!deleted) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });

        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error('Error deleting report schedule:', error);
        return NextResponse.json({ error: 'Failed to delete report schedule' }, { status: 500 });
    }
}
