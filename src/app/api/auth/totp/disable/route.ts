/**
 * POST /api/auth/totp/disable — turn off TOTP for the current user.
 * Requires a valid current TOTP code or an unused recovery code
 * (a pending, never-confirmed enrollment can be discarded without one).
 *
 * /api/auth/* is public in the middleware, so this route authenticates
 * itself via requireAuth().
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { disableTotp } from '@/lib/totp-store';

const DisableSchema = z.object({
    code: z.string().max(64).optional().default(''),
});

export async function POST(request: NextRequest) {
    try {
        const authResult = await requireAuth();
        if (authResult instanceof NextResponse) return authResult;

        const body = await request.json().catch(() => ({}));
        const parseResult = DisableSchema.safeParse(body);
        if (!parseResult.success) {
            return NextResponse.json(
                { error: 'Validation failed', errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        const ok = await disableTotp(authResult.user.id, parseResult.data.code);
        if (!ok) {
            return NextResponse.json(
                { error: 'That code was not valid. Enter a current code or a recovery code.' },
                { status: 400 }
            );
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('TOTP disable error:', error);
        return NextResponse.json({ error: 'Failed to disable 2FA' }, { status: 500 });
    }
}
