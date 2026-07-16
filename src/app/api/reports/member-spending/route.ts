import { NextRequest, NextResponse } from 'next/server';
import { generateMemberSpending, MemberBucketNames } from '@/lib/reports/member-spending';
import { ReportFilters } from '@/lib/reports/types';
import { getBookAccountGuids, getActiveBookGuid } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';
import { getEntityProfile } from '@/lib/services/entity.service';

/**
 * GET /api/reports/member-spending?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *
 * Spending by Member: period expenses attributed to the owner of the
 * funding (non-expense) account of each transaction. Defaults to the
 * current year through today.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const bookAccountGuids = await getBookAccountGuids();

        const filters: ReportFilters = {
            startDate: searchParams.get('startDate'),
            endDate: searchParams.get('endDate'),
            bookAccountGuids,
        };

        // Resolve self/spouse bucket labels to household member names from the
        // book's entity profile. Names are cosmetic — never fail the report.
        let ownerNames: MemberBucketNames | undefined;
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

        const report = await generateMemberSpending(filters, ownerNames);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating member spending report:', error);
        return NextResponse.json(
            { error: 'Failed to generate member spending report' },
            { status: 500 }
        );
    }
}
