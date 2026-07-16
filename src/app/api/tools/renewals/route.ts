import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    listRenewals,
    createRenewal,
    parseRenewalInput,
    RenewalError,
} from '@/lib/services/renewals.service';

/**
 * GET /api/tools/renewals
 * All renewals for the active book, soonest first.
 */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const renewals = await listRenewals(bookGuid);
        return NextResponse.json({ renewals });
    } catch (error) {
        console.error('Error listing renewals:', error);
        return NextResponse.json({ error: 'Failed to load renewals' }, { status: 500 });
    }
}

/**
 * POST /api/tools/renewals
 * Create a renewal (source 'manual').
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const body = await request.json().catch(() => null);
        const input = parseRenewalInput(body);
        const renewal = await createRenewal(bookGuid, input, 'manual');
        return NextResponse.json(renewal, { status: 201 });
    } catch (error) {
        if (error instanceof RenewalError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error('Error creating renewal:', error);
        return NextResponse.json({ error: 'Failed to create renewal' }, { status: 500 });
    }
}
