import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    updateServiceEntry,
    deleteServiceEntry,
    type ServiceEntryInput,
} from '@/lib/services/home.service';
import { handleHomeError, parseRouteId } from '../../_lib';

type RouteParams = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseRouteId(params);
        if (id === null) {
            return NextResponse.json({ error: 'Invalid service entry ID' }, { status: 400 });
        }

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const opt = <T>(key: string, coerce: (v: unknown) => T): T | null | undefined => {
            if (!(key in body) || body[key] === undefined) return undefined;
            if (body[key] === null || body[key] === '') return null;
            return coerce(body[key]);
        };
        const input: ServiceEntryInput = {
            taskId: opt('taskId', Number),
            itemId: opt('itemId', Number),
            serviceDate: body.serviceDate === undefined ? undefined : String(body.serviceDate),
            cost: opt('cost', Number),
            vendor: opt('vendor', String),
            txnGuid: opt('txnGuid', String),
            notes: opt('notes', String),
        };

        const entry = await updateServiceEntry(bookGuid, id, input);
        return NextResponse.json({ entry });
    } catch (error) {
        return handleHomeError(error, 'Error updating home service entry', 'Failed to update entry');
    }
}

export async function DELETE(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const id = await parseRouteId(params);
        if (id === null) {
            return NextResponse.json({ error: 'Invalid service entry ID' }, { status: 400 });
        }

        await deleteServiceEntry(bookGuid, id);
        return NextResponse.json({ success: true });
    } catch (error) {
        return handleHomeError(error, 'Error deleting home service entry', 'Failed to delete entry');
    }
}
