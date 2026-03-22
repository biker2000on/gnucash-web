import { NextRequest, NextResponse } from 'next/server';
import { getBookAccountGuids, getActiveBookGuid } from '@/lib/book-scope';
import { getEffectiveStartDate } from '@/lib/date-utils';
import { cacheGet, cacheSet } from '@/lib/cache';
import { requireRole } from '@/lib/auth';
import { FinancialSummaryService } from '@/lib/services/financial-summary.service';

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const searchParams = request.nextUrl.searchParams;
        const startDateParam = searchParams.get('startDate');
        const endDateParam = searchParams.get('endDate');

        const now = new Date();
        const endDate = endDateParam ? new Date(endDateParam + 'T23:59:59Z') : now;

        // Get book account GUIDs for scoping (needed for effective start date)
        const bookAccountGuids = await getBookAccountGuids();
        const startDate = await getEffectiveStartDate(startDateParam, bookAccountGuids);

        // Build cache key from book guid + metric + date params
        const bookGuid = await getActiveBookGuid();
        const cacheKey = `cache:${bookGuid}:kpis:${startDate.toISOString().split('T')[0]}-${endDate.toISOString().split('T')[0]}`;

        // Check cache first
        const cached = await cacheGet(cacheKey);
        if (cached) {
            return NextResponse.json(cached);
        }

        const responseData = await FinancialSummaryService.computeFullSummary(
            bookAccountGuids,
            startDate,
            endDate
        );

        // Cache the result (24 hour TTL)
        await cacheSet(cacheKey, responseData, 86400);

        return NextResponse.json(responseData);
    } catch (error) {
        console.error('Error fetching KPI data:', error);
        return NextResponse.json(
            { error: 'Failed to fetch KPI data' },
            { status: 500 }
        );
    }
}
