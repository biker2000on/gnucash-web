import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listTasks, createTask, type TaskInput } from '@/lib/services/home.service';
import { handleHomeError } from '../_lib';

function coerceTaskInput(body: Record<string, unknown>): TaskInput {
    const opt = <T>(key: string, coerce: (v: unknown) => T): T | null | undefined => {
        if (!(key in body) || body[key] === undefined) return undefined;
        if (body[key] === null || body[key] === '') return null;
        return coerce(body[key]);
    };
    return {
        name: body.name === undefined ? undefined : String(body.name),
        cadenceMonths: opt('cadenceMonths', Number),
        season: opt('season', String),
        itemId: opt('itemId', Number),
        lastDone: opt('lastDone', String),
        active: body.active === undefined ? undefined : Boolean(body.active),
        notes: opt('notes', String),
    };
}

/** GET /api/home/tasks?includeInactive=true — tasks with computed next-due. */
export async function GET(request: Request) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { searchParams } = new URL(request.url);
        const includeInactive = searchParams.get('includeInactive') === 'true';

        const tasks = await listTasks(bookGuid, { includeInactive });
        return NextResponse.json({ tasks });
    } catch (error) {
        return handleHomeError(error, 'Error listing home tasks', 'Failed to list tasks');
    }
}

/** POST /api/home/tasks — create a maintenance task. */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const task = await createTask(bookGuid, coerceTaskInput(body));
        return NextResponse.json({ task }, { status: 201 });
    } catch (error) {
        return handleHomeError(error, 'Error creating home task', 'Failed to create task');
    }
}
