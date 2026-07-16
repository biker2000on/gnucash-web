import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { importRenewalsFromSubscriptions } from '@/lib/services/renewals.service';

/**
 * POST /api/tools/renewals/import
 * Pull detected recurring charges (subscriptions tool) into the renewals
 * tracker: non-stopped monthly/quarterly/annual series become renewals with
 * their next expected date and latest amount, source 'subscription'.
 * Series whose name matches an existing renewal are skipped.
 */
export async function POST() {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const bookAccountGuids = await getBookAccountGuids();
        const result = await importRenewalsFromSubscriptions(bookGuid, bookAccountGuids);
        return NextResponse.json(result);
    } catch (error) {
        console.error('Error importing renewals from subscriptions:', error);
        return NextResponse.json({ error: 'Failed to import from subscriptions' }, { status: 500 });
    }
}
