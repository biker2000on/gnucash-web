import { NextRequest, NextResponse } from 'next/server';
import { generateAgingReport, type AgingSide } from '@/lib/business/business-reports';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const sideParam = searchParams.get('side') ?? 'ar';
        if (sideParam !== 'ar' && sideParam !== 'ap') {
            return NextResponse.json(
                { error: "Invalid side. Must be 'ar' or 'ap'." },
                { status: 400 }
            );
        }
        const side: AgingSide = sideParam;

        const bookAccountGuids = await getBookAccountGuids();
        const report = await generateAgingReport(side, bookAccountGuids);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating aging report:', error);
        return NextResponse.json(
            { error: 'Failed to generate aging report' },
            { status: 500 }
        );
    }
}
