import { NextResponse } from 'next/server';
import { generateBusinessDashboard } from '@/lib/business/business-reports';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const bookAccountGuids = await getBookAccountGuids();
        const dashboard = await generateBusinessDashboard(bookAccountGuids);
        return NextResponse.json(dashboard);
    } catch (error) {
        console.error('Error generating business dashboard:', error);
        return NextResponse.json(
            { error: 'Failed to generate business dashboard' },
            { status: 500 }
        );
    }
}
