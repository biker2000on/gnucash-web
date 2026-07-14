import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { get1099Summary, parseYearParam } from '@/lib/business/vendor-1099.service';

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { searchParams } = new URL(request.url);
        const year = parseYearParam(searchParams.get('year'));
        if (year === null) {
            return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
        }

        const bookAccountGuids = await getBookAccountGuids();
        const summary = await get1099Summary(bookGuid, bookAccountGuids, year);
        return NextResponse.json(summary);
    } catch (error) {
        console.error('Error generating 1099 summary:', error);
        return NextResponse.json(
            { error: 'Failed to generate 1099 summary' },
            { status: 500 }
        );
    }
}
