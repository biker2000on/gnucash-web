/**
 * POST /api/auth/totp/begin — start (or restart) opt-in TOTP enrollment.
 * Creates a pending secret; nothing changes for login until the user
 * confirms with a live code.
 *
 * /api/auth/* is public in the middleware, so this route authenticates
 * itself via requireAuth().
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { beginEnrollment } from '@/lib/totp-store';
import { otpauthUri } from '@/lib/totp';

export async function POST() {
    try {
        const authResult = await requireAuth();
        if (authResult instanceof NextResponse) return authResult;
        const { user } = authResult;

        const { secret } = await beginEnrollment(user.id);
        return NextResponse.json({
            secret,
            otpauthUri: otpauthUri(secret, user.username),
        });
    } catch (error) {
        if (error instanceof Error && error.message.includes('already enabled')) {
            return NextResponse.json({ error: error.message }, { status: 409 });
        }
        console.error('TOTP begin error:', error);
        return NextResponse.json({ error: 'Failed to start 2FA enrollment' }, { status: 500 });
    }
}
