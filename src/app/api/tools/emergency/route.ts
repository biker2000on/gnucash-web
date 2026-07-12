import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import {
    buildEmergencyPackage,
    upsertBookEmergencySections,
    type BookEmergencySections,
} from '@/lib/emergency-info';

/**
 * GET /api/tools/emergency
 *
 * Returns the full In Case of Emergency package for the active book:
 * balances as of now, per-account emergency metadata, institution grouping,
 * and the book-level free-text sections.
 */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const bookAccountGuids = await getBookAccountGuids();
        const pkg = await buildEmergencyPackage(bookAccountGuids, roleResult.bookGuid);
        return NextResponse.json(pkg);
    } catch (error) {
        console.error('Emergency package API error:', error);
        return NextResponse.json(
            { error: 'Failed to build emergency package' },
            { status: 500 },
        );
    }
}

/**
 * PUT /api/tools/emergency
 *
 * Update the book-level free-text sections (executor, attorney, insurance,
 * instructions). Body: { sections: { executor?, attorney?, insurance?, instructions? } }
 */
export async function PUT(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json().catch(() => null);
        const sections = (body?.sections ?? body) as Partial<BookEmergencySections> | null;
        if (!sections || typeof sections !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const saved = await upsertBookEmergencySections(roleResult.bookGuid, sections);
        return NextResponse.json({ sections: saved });
    } catch (error) {
        console.error('Emergency sections API error:', error);
        return NextResponse.json(
            { error: 'Failed to save emergency sections' },
            { status: 500 },
        );
    }
}
