import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import {
    getGoalsWithProgress,
    createGoal,
    parseGoalBody,
} from '@/lib/services/goal.service';

/**
 * GET /api/goals
 * Lists the active book's goals with computed progress + projections.
 */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const bookAccountGuids = await getBookAccountGuids();
        const goals = await getGoalsWithProgress(bookAccountGuids, bookGuid);
        return NextResponse.json(goals);
    } catch (error) {
        console.error('Error fetching goals:', error);
        return NextResponse.json({ error: 'Failed to fetch goals' }, { status: 500 });
    }
}

/**
 * POST /api/goals
 * Creates a goal in the active book.
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const body = await request.json().catch(() => null);
        const parsed = parseGoalBody(body);
        if ('error' in parsed) {
            return NextResponse.json({ error: parsed.error }, { status: 400 });
        }

        const goal = await createGoal(bookGuid, parsed.input);
        return NextResponse.json(goal, { status: 201 });
    } catch (error) {
        console.error('Error creating goal:', error);
        return NextResponse.json({ error: 'Failed to create goal' }, { status: 500 });
    }
}
