import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { getUserRoleForBook } from '@/lib/services/permission.service';
import { isOidcConfigured, getOidcProviderName } from '@/lib/oidc';

export async function GET() {
    try {
        const session = await getSession();

        if (!session.isLoggedIn || !session.userId) {
            return NextResponse.json(
                { error: 'Not authenticated' },
                { status: 401 }
            );
        }

        const user = await prisma.gnucash_web_users.findUnique({
            where: { id: session.userId },
            select: {
                id: true,
                username: true,
                email: true,
                display_name: true,
                avatar_url: true,
                auth_method: true,
                password_hash: true,
                oidc_subject: true,
            },
        });

        if (!user) {
            return NextResponse.json(
                { error: 'Not authenticated' },
                { status: 401 }
            );
        }

        await session.save();

        // Role for the active book (falls back to the first book, matching requireRole)
        let role: string | null = null;
        let bookGuid = session.activeBookGuid;
        if (!bookGuid) {
            const firstBook = await prisma.books.findFirst({ select: { guid: true } });
            bookGuid = firstBook?.guid;
        }
        if (bookGuid) {
            role = await getUserRoleForBook(user.id, bookGuid);
        }

        return NextResponse.json({
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                displayName: user.display_name,
                avatarUrl: user.avatar_url,
                authMethod: user.auth_method,
                hasPassword: Boolean(user.password_hash),
                oidcLinked: Boolean(user.oidc_subject),
                oidcProvider: isOidcConfigured() ? getOidcProviderName() : null,
                role,
            },
        });
    } catch (error) {
        console.error('Get user error:', error);
        return NextResponse.json(
            { error: 'Failed to get user' },
            { status: 500 }
        );
    }
}
