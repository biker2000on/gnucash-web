import { NextRequest, NextResponse } from 'next/server';
import { BudgetService } from '@/lib/services/budget.service';

// PATCH - Update a single budget amount (inline cell edit)
export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;
        const body = await request.json();
        const { account_guid, period_num, amount } = body;

        if (!account_guid || (period_num === undefined || period_num === null) || amount === undefined) {
            return NextResponse.json(
                { error: 'Missing required fields: account_guid, period_num, amount' },
                { status: 400 }
            );
        }

        const result = await BudgetService.setAmount(guid, account_guid, period_num, amount);
        return NextResponse.json(result);
    } catch (error) {
        console.error('Error updating budget amount:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to update budget amount' },
            { status: 500 }
        );
    }
}

// DELETE - Remove all amounts for an account from budget
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;
        const { searchParams } = new URL(request.url);
        const accountGuid = searchParams.get('account_guid');

        if (!accountGuid) {
            return NextResponse.json(
                { error: 'Missing required query parameter: account_guid' },
                { status: 400 }
            );
        }

        const deletedCount = await BudgetService.deleteAccountAmounts(guid, accountGuid);
        return NextResponse.json({ success: true, deleted_count: deletedCount });
    } catch (error) {
        console.error('Error deleting budget amounts:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to delete budget amounts' },
            { status: 500 }
        );
    }
}
