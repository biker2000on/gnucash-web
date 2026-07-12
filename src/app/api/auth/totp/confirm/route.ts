/**
 * POST /api/auth/totp/confirm — confirm enrollment with a live code from
 * the authenticator app. On success TOTP becomes enabled and the recovery
 * codes are returned (the only time they are ever shown).
 *
 * /api/auth/* is public in the middleware, so this route authenticates
 * itself via requireAuth().
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { confirmEnrollment } from '@/lib/totp-store';

const ConfirmSchema = z.object({
    code: z.string().min(1, 'Code is required').max(16),
});

export async function POST(request: NextRequest) {
    try {
        const authResult = await requireAuth();
        if (authResult instanceof NextResponse) return authResult;

        const body = await request.json();
        const parseResult = ConfirmSchema.safeParse(body);
        if (!parseResult.success) {
            return NextResponse.json(
                { error: 'Validation failed', errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        const result = await confirmEnrollment(authResult.user.id, parseResult.data.code);
        if (!result) {
            return NextResponse.json(
                { error: 'That code was not valid. Check your authenticator app and try again.' },
                { status: 400 }
            );
        }

        return NextResponse.json({ success: true, recoveryCodes: result.recoveryCodes });
    } catch (error) {
        if (error instanceof Error && /enrollment|already enabled|unreadable/i.test(error.message)) {
            return NextResponse.json({ error: error.message }, { status: 409 });
        }
        console.error('TOTP confirm error:', error);
        return NextResponse.json({ error: 'Failed to confirm 2FA enrollment' }, { status: 500 });
    }
}
