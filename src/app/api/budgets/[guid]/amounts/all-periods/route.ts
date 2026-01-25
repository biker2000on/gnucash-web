import { NextRequest, NextResponse } from 'next/server';
import { BudgetService } from '@/lib/services/budget.service';

// POST - Set the same amount for all periods of an account
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;
        const body = await request.json();
        const { account_guid, amount } = body;

        if (!account_guid || amount === undefined) {
            return NextResponse.json(
                { error: 'Missing required fields: account_guid, amount' },
                { status: 400 }
            );
        }

        const amounts = await BudgetService.setAllPeriods(guid, account_guid, amount);
        return NextResponse.json({ success: true, amounts });
    } catch (error) {
        console.error('Error setting all periods:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to set all periods' },
            { status: 500 }
        );
    }
}
