/**
 * GET /api/auth/totp/status — current user's TOTP enrollment status.
 *
 * /api/auth/* is public in the middleware, so this route authenticates
 * itself via requireAuth().
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getTotpStatus } from '@/lib/totp-store';

export async function GET() {
    try {
        const authResult = await requireAuth();
        if (authResult instanceof NextResponse) return authResult;

        const status = await getTotpStatus(authResult.user.id);
        return NextResponse.json(status);
    } catch (error) {
        console.error('TOTP status error:', error);
        return NextResponse.json({ error: 'Failed to load 2FA status' }, { status: 500 });
    }
}
