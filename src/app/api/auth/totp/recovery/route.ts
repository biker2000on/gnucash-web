/**
 * POST /api/auth/totp/recovery — regenerate recovery codes (invalidates all
 * previous ones). Requires a valid current TOTP code or an unused recovery
 * code. Returns the new codes — the only time they are shown.
 *
 * /api/auth/* is public in the middleware, so this route authenticates
 * itself via requireAuth().
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { regenerateRecoveryCodes } from '@/lib/totp-store';

const RecoverySchema = z.object({
    code: z.string().min(1, 'Code is required').max(64),
});

export async function POST(request: NextRequest) {
    try {
        const authResult = await requireAuth();
        if (authResult instanceof NextResponse) return authResult;

        const body = await request.json();
        const parseResult = RecoverySchema.safeParse(body);
        if (!parseResult.success) {
            return NextResponse.json(
                { error: 'Validation failed', errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        const result = await regenerateRecoveryCodes(authResult.user.id, parseResult.data.code);
        if (!result) {
            return NextResponse.json(
                { error: 'That code was not valid. Enter a current code or a recovery code.' },
                { status: 400 }
            );
        }

        return NextResponse.json({ success: true, recoveryCodes: result.recoveryCodes });
    } catch (error) {
        if (error instanceof Error && error.message.includes('not enabled')) {
            return NextResponse.json({ error: error.message }, { status: 409 });
        }
        console.error('TOTP recovery regenerate error:', error);
        return NextResponse.json({ error: 'Failed to regenerate recovery codes' }, { status: 500 });
    }
}
