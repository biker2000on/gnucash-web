import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { seedMaintenanceTemplate } from '@/lib/services/home.service';
import { handleHomeError } from '../../_lib';

/**
 * POST /api/home/tasks/seed — create the standard maintenance template
 * (HVAC filter, smoke detectors, gutters, …) when the book has zero tasks;
 * a no-op that returns the existing tasks otherwise.
 */
export async function POST() {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const tasks = await seedMaintenanceTemplate(bookGuid);
        return NextResponse.json({ tasks });
    } catch (error) {
        return handleHomeError(error, 'Error seeding home tasks', 'Failed to seed tasks');
    }
}
