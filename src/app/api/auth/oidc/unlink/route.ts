import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { canUnlinkOidc } from '@/lib/oidc-resolve';

/**
 * POST /api/auth/oidc/unlink
 *
 * Removes the OIDC identity from the current user's account.
 * Refused when the user has no password (it would lock them out).
 */
export async function POST() {
    const authResult = await requireAuth();
    if (authResult instanceof NextResponse) return authResult;

    const user = await prisma.gnucash_web_users.findUnique({
        where: { id: authResult.user.id },
        select: { id: true, password_hash: true, oidc_subject: true },
    });

    if (!user) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const guard = canUnlinkOidc({
        hasPassword: Boolean(user.password_hash),
        oidc_subject: user.oidc_subject,
    });
    if (!guard.ok) {
        return NextResponse.json({ error: guard.reason }, { status: 400 });
    }

    await prisma.gnucash_web_users.update({
        where: { id: user.id },
        data: {
            oidc_subject: null,
            oidc_issuer: null,
            avatar_url: null,
            auth_method: 'password',
        },
    });

    return NextResponse.json({ success: true });
}
