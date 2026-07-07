import { NextRequest, NextResponse } from 'next/server';
import { generateNetWorthByOwner, OwnerBucketNames } from '@/lib/reports/net-worth-by-owner';
import { ReportFilters } from '@/lib/reports/types';
import { getBookAccountGuids, getActiveBookGuid } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';
import { getEntityProfile } from '@/lib/services/entity.service';

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const bookAccountGuids = await getBookAccountGuids();

        // Point-in-time report: balances through asOf (endDate accepted as an
        // alias so ReportViewer-driven pages work unchanged). Defaults to today.
        const asOf = searchParams.get('asOf') ?? searchParams.get('endDate');

        const filters: ReportFilters = {
            startDate: null,
            endDate: asOf,
            bookAccountGuids,
        };

        // Resolve self/spouse bucket labels to household member names from the
        // book's entity profile. Names are cosmetic — never fail the report.
        let ownerNames: OwnerBucketNames | undefined;
        try {
            const bookGuid = await getActiveBookGuid();
            const entity = await getEntityProfile(bookGuid, roleResult.user.id);
            ownerNames = {
                self: entity.members.find(m => m.role === 'self')?.name?.trim() || null,
                spouse: entity.members.find(m => m.role === 'spouse')?.name?.trim() || null,
            };
        } catch {
            ownerNames = undefined;
        }

        const report = await generateNetWorthByOwner(filters, ownerNames);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating net worth by owner report:', error);
        return NextResponse.json(
            { error: 'Failed to generate net worth by owner report' },
            { status: 500 }
        );
    }
}
