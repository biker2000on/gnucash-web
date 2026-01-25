import { NextRequest, NextResponse } from 'next/server';
import { BudgetService } from '@/lib/services/budget.service';

// POST - Add an account to the budget
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;
        const body = await request.json();
        const { account_guid } = body;

        if (!account_guid) {
            return NextResponse.json(
                { error: 'Missing required field: account_guid' },
                { status: 400 }
            );
        }

        const amounts = await BudgetService.addAccount(guid, account_guid);
        return NextResponse.json({ success: true, amounts });
    } catch (error) {
        console.error('Error adding account to budget:', error);
        const message = error instanceof Error ? error.message : 'Failed to add account';
        const status = message.includes('already in budget') ? 400 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
