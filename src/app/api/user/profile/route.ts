import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { z } from 'zod';

const ProfileSchema = z.object({
    email: z.union([z.email().max(255), z.literal('')]).optional(),
});

/**
 * PATCH /api/user/profile
 *
 * Update the current user's own profile. Email is only editable for accounts
 * that are not OIDC-linked — for linked accounts the email is sourced from the
 * identity provider and kept read-only.
 */
export async function PATCH(request: NextRequest) {
    const authResult = await requireAuth();
    if (authResult instanceof NextResponse) return authResult;

    const body = await request.json().catch(() => null);
    const parsed = ProfileSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'Validation failed', errors: parsed.error.issues },
            { status: 400 }
        );
    }

    const { email } = parsed.data;
    if (email === undefined) {
        return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    const user = await prisma.gnucash_web_users.findUnique({
        where: { id: authResult.user.id },
        select: { id: true, oidc_subject: true },
    });
    if (!user) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (user.oidc_subject) {
        return NextResponse.json(
            { error: 'Email is managed by your identity provider' },
            { status: 400 }
        );
    }

    const normalized = email === '' ? null : email.toLowerCase();

    if (normalized) {
        const existing = await prisma.gnucash_web_users.findFirst({
            where: { email: normalized, NOT: { id: user.id } },
            select: { id: true },
        });
        if (existing) {
            return NextResponse.json(
                { error: 'Email is already in use by another account' },
                { status: 409 }
            );
        }
    }

    await prisma.gnucash_web_users.update({
        where: { id: user.id },
        data: { email: normalized },
    });

    return NextResponse.json({ success: true, email: normalized });
}
