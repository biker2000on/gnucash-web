import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { updateGoal, deleteGoal, parseGoalBody } from '@/lib/services/goal.service';

/**
 * PUT /api/goals/{id}
 * Replaces a goal's fields (book-scoped).
 */
export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { id: idParam } = await params;
        const id = parseInt(idParam, 10);
        if (!Number.isInteger(id)) {
            return NextResponse.json({ error: 'Invalid goal id' }, { status: 400 });
        }

        const body = await request.json().catch(() => null);
        const parsed = parseGoalBody(body);
        if ('error' in parsed) {
            return NextResponse.json({ error: parsed.error }, { status: 400 });
        }

        const goal = await updateGoal(bookGuid, id, parsed.input);
        if (!goal) {
            return NextResponse.json({ error: 'Goal not found' }, { status: 404 });
        }
        return NextResponse.json(goal);
    } catch (error) {
        console.error('Error updating goal:', error);
        return NextResponse.json({ error: 'Failed to update goal' }, { status: 500 });
    }
}

/**
 * DELETE /api/goals/{id}
 * Deletes a goal (book-scoped).
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
        const id = parseInt(idParam, 10);
        if (!Number.isInteger(id)) {
            return NextResponse.json({ error: 'Invalid goal id' }, { status: 400 });
        }

        const deleted = await deleteGoal(bookGuid, id);
        if (!deleted) {
            return NextResponse.json({ error: 'Goal not found' }, { status: 404 });
        }
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting goal:', error);
        return NextResponse.json({ error: 'Failed to delete goal' }, { status: 500 });
    }
}
