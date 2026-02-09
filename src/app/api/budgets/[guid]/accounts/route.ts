import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { BudgetService } from '@/lib/services/budget.service';
import { getBookAccountGuids } from '@/lib/book-scope';

// GET - List all accounts for budget tree building
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;

        // Verify budget exists
        const budget = await prisma.budgets.findUnique({ where: { guid } });
        if (!budget) {
            return NextResponse.json({ error: 'Budget not found' }, { status: 404 });
        }

        // Get ALL accounts in active book (not just budgeted ones)
        const bookAccountGuids = await getBookAccountGuids();
        const accounts = await prisma.accounts.findMany({
            where: {
                guid: { in: bookAccountGuids },
                NOT: { account_type: 'ROOT' },
            },
            select: {
                guid: true,
                name: true,
                account_type: true,
                parent_guid: true,
                commodity: {
                    select: { mnemonic: true }
                }
            },
            orderBy: { name: 'asc' }
        });

        return NextResponse.json(accounts);
    } catch (error) {
        console.error('Error fetching accounts:', error);
        return NextResponse.json({ error: 'Failed to fetch accounts' }, { status: 500 });
    }
}

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
