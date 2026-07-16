import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { seedDefaultRooms } from '@/lib/services/home.service';
import { handleHomeError } from '../../_lib';

/**
 * POST /api/home/rooms/seed — create the default room set (Living Room,
 * Kitchen, …) when the book has zero rooms; a no-op that returns the
 * existing rooms otherwise. Used by the "start walk-through" first-use path.
 */
export async function POST() {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const rooms = await seedDefaultRooms(bookGuid);
        return NextResponse.json({ rooms });
    } catch (error) {
        return handleHomeError(error, 'Error seeding home rooms', 'Failed to seed rooms');
    }
}
