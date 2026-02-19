import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { BalanceReversal } from '@/lib/format';
import { getAllPreferences, setPreferences, getChartDefaults, getPreference, setPreference } from '@/lib/user-preferences';

const VALID_BALANCE_REVERSALS: BalanceReversal[] = ['none', 'credit', 'income_expense'];

/**
 * GET /api/user/preferences
 * Get the current user's preferences.
 * - No query param: returns balanceReversal (legacy)
 * - ?key=prefix.*: returns key-value preferences matching prefix
 * - ?key=chart_defaults: returns parsed chart defaults
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const keyParam = request.nextUrl.searchParams.get('key');

        // If key=chart_defaults, return structured chart defaults
        if (keyParam === 'chart_defaults') {
            const defaults = await getChartDefaults(roleResult.user.id);
            return NextResponse.json(defaults);
        }

        // If key param provided with wildcard, return matching key-value preferences
        if (keyParam) {
            const prefix = keyParam.replace(/\.\*$/, '.');
            const prefs = await getAllPreferences(roleResult.user.id, prefix);
            return NextResponse.json({ preferences: prefs });
        }

        // Default: return legacy balanceReversal and tax rate
        const user = await prisma.gnucash_web_users.findUnique({
            where: { id: roleResult.user.id },
            select: {
                balance_reversal: true,
            },
        });

        if (!user) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        // Fetch tax rate from key-value preferences
        const taxRatePref = await getPreference(roleResult.user.id, 'default_tax_rate', 0);

        return NextResponse.json({
            balanceReversal: user.balance_reversal || 'none',
            defaultTaxRate: typeof taxRatePref === 'number' ? taxRatePref : parseFloat(taxRatePref as string) || 0,
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
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json();
        const { balanceReversal, defaultTaxRate } = body;

        // Validate balance reversal value
        if (balanceReversal !== undefined) {
            if (!VALID_BALANCE_REVERSALS.includes(balanceReversal)) {
                return NextResponse.json(
                    { error: `Invalid balanceReversal value. Must be one of: ${VALID_BALANCE_REVERSALS.join(', ')}` },
                    { status: 400 }
                );
            }
        }

        // Validate tax rate value
        if (defaultTaxRate !== undefined) {
            const rate = parseFloat(defaultTaxRate);
            if (isNaN(rate) || rate < 0 || rate > 1) {
                return NextResponse.json(
                    { error: 'Invalid defaultTaxRate value. Must be a number between 0 and 1' },
                    { status: 400 }
                );
            }
        }

        // Update balance reversal if provided
        let updatedBalanceReversal = balanceReversal;
        if (balanceReversal !== undefined) {
            const updatedUser = await prisma.gnucash_web_users.update({
                where: { id: roleResult.user.id },
                data: {
                    balance_reversal: balanceReversal,
                },
                select: {
                    balance_reversal: true,
                },
            });
            updatedBalanceReversal = updatedUser.balance_reversal;
        }

        // Update tax rate if provided
        if (defaultTaxRate !== undefined) {
            await setPreference(roleResult.user.id, 'default_tax_rate', parseFloat(defaultTaxRate));
        }

        // Fetch current values for response
        const user = await prisma.gnucash_web_users.findUnique({
            where: { id: roleResult.user.id },
            select: { balance_reversal: true },
        });
        const taxRatePref = await getPreference(roleResult.user.id, 'default_tax_rate', 0);

        return NextResponse.json({
            balanceReversal: updatedBalanceReversal || user?.balance_reversal || 'none',
            defaultTaxRate: typeof taxRatePref === 'number' ? taxRatePref : parseFloat(taxRatePref as string) || 0,
        });
    } catch (error) {
        console.error('Error updating user preferences:', error);
        return NextResponse.json({ error: 'Failed to update preferences' }, { status: 500 });
    }
}

/**
 * PUT /api/user/preferences
 * Upsert key-value preferences.
 * Body: { preferences: { "key1": value1, "key2": value2, ... } }
 */
export async function PUT(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json();
        const { preferences } = body;

        if (!preferences || typeof preferences !== 'object') {
            return NextResponse.json(
                { error: 'Request body must include "preferences" object' },
                { status: 400 }
            );
        }

        await setPreferences(roleResult.user.id, preferences);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error saving user preferences:', error);
        return NextResponse.json({ error: 'Failed to save preferences' }, { status: 500 });
    }
}
