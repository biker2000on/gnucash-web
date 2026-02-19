import { NextRequest, NextResponse } from 'next/server';
import { BudgetService } from '@/lib/services/budget.service';
import { requireRole } from '@/lib/auth';

// GET - Get historical average for an account
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        await params; // Budget guid not needed for estimate, but kept for route consistency
        const { searchParams } = new URL(request.url);
        const accountGuid = searchParams.get('account_guid');
        const months = parseInt(searchParams.get('months') || '12', 10);

        if (!accountGuid) {
            return NextResponse.json(
                { error: 'Missing required query parameter: account_guid' },
                { status: 400 }
            );
        }

        if (isNaN(months) || months < 1 || months > 60) {
            return NextResponse.json(
                { error: 'Invalid months parameter (must be 1-60)' },
                { status: 400 }
            );
        }

        const estimate = await BudgetService.getHistoricalAverage(accountGuid, months);
        return NextResponse.json(estimate);
    } catch (error) {
        console.error('Error getting historical average:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to get estimate' },
            { status: 500 }
        );
    }
}
