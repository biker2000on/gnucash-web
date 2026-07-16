import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    updateRenewal,
    deleteRenewal,
    markRenewalRenewed,
    dismissRenewalUntil,
    parseRenewalInput,
    RenewalError,
} from '@/lib/services/renewals.service';

function parseId(idParam: string): number | null {
    const id = parseInt(idParam, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * PATCH /api/tools/renewals/{id}
 *
 * Body variants:
 *   { action: 'renew' }                    — advance renewal_date by the cadence
 *   { action: 'dismiss', until: 'YYYY-MM-DD' } — suppress reminders through a date
 *   { name?, renewalDate?, amount?, ... }  — partial field edit
 */
export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { id: idParam } = await params;
        const id = parseId(idParam);
        if (id === null) {
            return NextResponse.json({ error: 'Invalid renewal id' }, { status: 400 });
        }

        const body = await request.json().catch(() => null) as Record<string, unknown> | null;

        if (body?.action === 'renew') {
            const renewal = await markRenewalRenewed(bookGuid, id);
            if (!renewal) return NextResponse.json({ error: 'Renewal not found' }, { status: 404 });
            return NextResponse.json(renewal);
        }

        if (body?.action === 'dismiss') {
            const until = typeof body.until === 'string' ? body.until : '';
            const renewal = await dismissRenewalUntil(bookGuid, id, until);
            if (!renewal) return NextResponse.json({ error: 'Renewal not found' }, { status: 404 });
            return NextResponse.json(renewal);
        }

        const input = parseRenewalInput(body, { partial: true });
        const renewal = await updateRenewal(bookGuid, id, input);
        if (!renewal) return NextResponse.json({ error: 'Renewal not found' }, { status: 404 });
        return NextResponse.json(renewal);
    } catch (error) {
        if (error instanceof RenewalError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error('Error updating renewal:', error);
        return NextResponse.json({ error: 'Failed to update renewal' }, { status: 500 });
    }
}

/**
 * DELETE /api/tools/renewals/{id}
 */
export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { id: idParam } = await params;
        const id = parseId(idParam);
        if (id === null) {
            return NextResponse.json({ error: 'Invalid renewal id' }, { status: 400 });
        }

        const deleted = await deleteRenewal(bookGuid, id);
        if (!deleted) return NextResponse.json({ error: 'Renewal not found' }, { status: 404 });
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting renewal:', error);
        return NextResponse.json({ error: 'Failed to delete renewal' }, { status: 500 });
    }
}
