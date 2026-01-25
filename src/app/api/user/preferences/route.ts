import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { BalanceReversal } from '@/lib/format';

const VALID_BALANCE_REVERSALS: BalanceReversal[] = ['none', 'credit', 'income_expense'];

/**
 * GET /api/user/preferences
 * Get the current user's preferences
 */
export async function GET() {
    try {
        const currentUser = await getCurrentUser();

        if (!currentUser) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        const user = await prisma.gnucash_web_users.findUnique({
            where: { id: currentUser.id },
            select: {
                balance_reversal: true,
            },
        });

        if (!user) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        return NextResponse.json({
            balanceReversal: user.balance_reversal || 'none',
        });
    } catch (error) {
        console.error('Error fetching user preferences:', error);
        return NextResponse.json({ error: 'Failed to fetch preferences' }, { status: 500 });
    }
}

/**
 * PATCH /api/user/preferences
 * Update the current user's preferences
 */
export async function PATCH(request: NextRequest) {
    try {
        const currentUser = await getCurrentUser();

        if (!currentUser) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        const body = await request.json();
        const { balanceReversal } = body;

        // Validate balance reversal value
        if (balanceReversal !== undefined) {
            if (!VALID_BALANCE_REVERSALS.includes(balanceReversal)) {
                return NextResponse.json(
                    { error: `Invalid balanceReversal value. Must be one of: ${VALID_BALANCE_REVERSALS.join(', ')}` },
                    { status: 400 }
                );
            }
        }

        const updatedUser = await prisma.gnucash_web_users.update({
            where: { id: currentUser.id },
            data: {
                balance_reversal: balanceReversal,
            },
            select: {
                balance_reversal: true,
            },
        });

        return NextResponse.json({
            balanceReversal: updatedUser.balance_reversal,
        });
    } catch (error) {
        console.error('Error updating user preferences:', error);
        return NextResponse.json({ error: 'Failed to update preferences' }, { status: 500 });
    }
}
