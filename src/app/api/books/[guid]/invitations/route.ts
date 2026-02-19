import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getUserRoleForBook } from '@/lib/services/permission.service';

/**
 * POST /api/books/[guid]/invitations
 * Create an invitation for a book (admin only).
 */
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('admin');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        const { user } = roleResult;

        // Verify the user is admin of THIS book (not just their active book)
        const userRole = await getUserRoleForBook(user.id, guid);
        if (userRole !== 'admin') {
            return NextResponse.json({ error: 'Admin access required for this book' }, { status: 403 });
        }

        const body = await request.json();
        const { role, expiresInHours, maxUses } = body;

        // Validate role (max is 'edit', cannot grant admin via invitation)
        if (!role || !['readonly', 'edit'].includes(role)) {
            return NextResponse.json(
                { error: 'Role must be "readonly" or "edit"' },
                { status: 400 }
            );
        }

        // Validate expiresInHours
        const hours = Number(expiresInHours);
        if (!hours || hours <= 0 || hours > 43800) { // max ~5 years
            return NextResponse.json(
                { error: 'expiresInHours must be between 1 and 43800' },
                { status: 400 }
            );
        }

        // Validate maxUses
        const uses = Number(maxUses) || 1;
        if (uses < 1 || uses > 1000) {
            return NextResponse.json(
                { error: 'maxUses must be between 1 and 1000' },
                { status: 400 }
            );
        }

        // Verify book exists
        const book = await prisma.books.findUnique({ where: { guid } });
        if (!book) {
            return NextResponse.json({ error: 'Book not found' }, { status: 404 });
        }

        // Generate cryptographically random 64-char hex code
        const code = crypto.randomBytes(32).toString('hex');

        // Calculate expiry
        const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

        // Insert invitation
        await prisma.$executeRaw`
            INSERT INTO gnucash_web_invitations (code, book_guid, role_id, created_by, expires_at, max_uses)
            VALUES (
                ${code},
                ${guid},
                (SELECT id FROM gnucash_web_roles WHERE name = ${role}),
                ${user.id},
                ${expiresAt},
                ${uses}
            )
        `;

        return NextResponse.json({
            code,
            link: `/invite/${code}`,
            role,
            expiresAt: expiresAt.toISOString(),
            maxUses: uses,
        }, { status: 201 });
    } catch (error) {
        console.error('Error creating invitation:', error);
        return NextResponse.json({ error: 'Failed to create invitation' }, { status: 500 });
    }
}

/**
 * GET /api/books/[guid]/invitations
 * List all invitations for a book (admin only).
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('admin');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        const { user } = roleResult;

        // Verify admin of THIS book
        const userRole = await getUserRoleForBook(user.id, guid);
        if (userRole !== 'admin') {
            return NextResponse.json({ error: 'Admin access required for this book' }, { status: 403 });
        }

        const invitations = await prisma.$queryRaw<{
            id: number;
            code: string;
            role: string;
            created_at: Date;
            expires_at: Date;
            use_count: number;
            max_uses: number;
            is_revoked: boolean;
            created_by_username: string;
        }[]>`
            SELECT
                i.id, i.code, r.name as role,
                i.created_at, i.expires_at,
                i.use_count, i.max_uses, i.is_revoked,
                u.username as created_by_username
            FROM gnucash_web_invitations i
            JOIN gnucash_web_roles r ON r.id = i.role_id
            JOIN gnucash_web_users u ON u.id = i.created_by
            WHERE i.book_guid = ${guid}
            ORDER BY i.created_at DESC
        `;

        return NextResponse.json(invitations.map(inv => ({
            id: inv.id,
            code: inv.code,
            role: inv.role,
            createdAt: inv.created_at,
            expiresAt: inv.expires_at,
            useCount: Number(inv.use_count),
            maxUses: Number(inv.max_uses),
            isRevoked: inv.is_revoked,
            createdBy: inv.created_by_username,
            isExpired: new Date(inv.expires_at) < new Date(),
        })));
    } catch (error) {
        console.error('Error listing invitations:', error);
        return NextResponse.json({ error: 'Failed to list invitations' }, { status: 500 });
    }
}
