import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { updateTask, deleteTask, type TaskInput } from '@/lib/services/home.service';
import { handleHomeError, parseRouteId } from '../../_lib';

type RouteParams = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseRouteId(params);
        if (id === null) return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const opt = <T>(key: string, coerce: (v: unknown) => T): T | null | undefined => {
            if (!(key in body) || body[key] === undefined) return undefined;
            if (body[key] === null || body[key] === '') return null;
            return coerce(body[key]);
        };
        const input: TaskInput = {
            name: body.name === undefined ? undefined : String(body.name),
            cadenceMonths: opt('cadenceMonths', Number),
            season: opt('season', String),
            itemId: opt('itemId', Number),
            lastDone: opt('lastDone', String),
            active: body.active === undefined ? undefined : Boolean(body.active),
            notes: opt('notes', String),
        };

        const task = await updateTask(bookGuid, id, input);
        return NextResponse.json({ task });
    } catch (error) {
        return handleHomeError(error, 'Error updating home task', 'Failed to update task');
    }
}

export async function DELETE(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseRouteId(params);
        if (id === null) return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });

        await deleteTask(bookGuid, id);
        return NextResponse.json({ success: true });
    } catch (error) {
        return handleHomeError(error, 'Error deleting home task', 'Failed to delete task');
    }
}
