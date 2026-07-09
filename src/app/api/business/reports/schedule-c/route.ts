import { NextRequest, NextResponse } from 'next/server';
import { generateScheduleC } from '@/lib/business/business-reports';
import { getMappings } from '@/lib/business/schedule-c-mappings';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const yearParam = searchParams.get('year');
        const year = yearParam ? parseInt(yearParam, 10) : new Date().getUTCFullYear();
        if (!Number.isInteger(year) || year < 1900 || year > 2200) {
            return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
        }

        const bookAccountGuids = await getBookAccountGuids();
        const overrides = await getMappings(bookAccountGuids);
        const report = await generateScheduleC(bookAccountGuids, year, overrides);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating Schedule C report:', error);
        return NextResponse.json(
            { error: 'Failed to generate Schedule C report' },
            { status: 500 }
        );
    }
}
