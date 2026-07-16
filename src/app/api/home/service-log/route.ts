import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    listServiceLog,
    createServiceEntry,
    serviceCostForYear,
    type ServiceEntryInput,
} from '@/lib/services/home.service';
import { handleHomeError } from '../_lib';

function coerceServiceInput(body: Record<string, unknown>): ServiceEntryInput {
    const opt = <T>(key: string, coerce: (v: unknown) => T): T | null | undefined => {
        if (!(key in body) || body[key] === undefined) return undefined;
        if (body[key] === null || body[key] === '') return null;
        return coerce(body[key]);
    };
    return {
        taskId: opt('taskId', Number),
        itemId: opt('itemId', Number),
        serviceDate: body.serviceDate === undefined ? undefined : String(body.serviceDate),
        cost: opt('cost', Number),
        vendor: opt('vendor', String),
        txnGuid: opt('txnGuid', String),
        notes: opt('notes', String),
    };
}

/**
 * GET /api/home/service-log?taskId=&itemId= — entries newest-first, plus
 * the year-to-date maintenance cost for the whole book.
 */
export async function GET(request: Request) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { searchParams } = new URL(request.url);
        const filter: { taskId?: number; itemId?: number } = {};
        for (const key of ['taskId', 'itemId'] as const) {
            const raw = searchParams.get(key);
            if (raw !== null) {
                const parsed = parseInt(raw, 10);
                if (!Number.isInteger(parsed) || parsed <= 0) {
                    return NextResponse.json({ error: `Invalid ${key}` }, { status: 400 });
                }
                filter[key] = parsed;
            }
        }

        const [entries, ytdCost] = await Promise.all([
            listServiceLog(bookGuid, filter),
            serviceCostForYear(bookGuid, new Date().getUTCFullYear()),
        ]);
        return NextResponse.json({ entries, ytdCost });
    } catch (error) {
        return handleHomeError(error, 'Error listing home service log', 'Failed to list service log');
    }
}

/**
 * POST /api/home/service-log — log a service (optionally against a task
 * and/or item; a task link advances the task's last_done).
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const entry = await createServiceEntry(bookGuid, coerceServiceInput(body));
        return NextResponse.json({ entry }, { status: 201 });
    } catch (error) {
        return handleHomeError(error, 'Error creating home service entry', 'Failed to log service');
    }
}
