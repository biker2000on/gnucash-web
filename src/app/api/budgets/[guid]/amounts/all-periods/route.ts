import { NextRequest, NextResponse } from 'next/server';
import { BudgetService } from '@/lib/services/budget.service';
import { requireRole } from '@/lib/auth';

// POST - Set all periods of an account: flat `amount` or per-period `amounts[]`
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        const body = await request.json();
        const { account_guid, amount, amounts: amountsArray } = body;

        const hasFlat = typeof amount === 'number' && Number.isFinite(amount);
        const hasArray = Array.isArray(amountsArray)
            && amountsArray.length > 0
            && amountsArray.every((v: unknown) => typeof v === 'number' && Number.isFinite(v));

        if (!account_guid || (!hasFlat && !hasArray)) {
            return NextResponse.json(
                { error: 'Missing required fields: account_guid and amount (number) or amounts (number[])' },
                { status: 400 }
            );
        }

        const amounts = await BudgetService.setAllPeriods(
            guid,
            account_guid,
            hasArray ? (amountsArray as number[]) : (amount as number)
        );
        return NextResponse.json({ success: true, amounts });
    } catch (error) {
        console.error('Error setting all periods:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to set all periods' },
            { status: 500 }
        );
    }
}
