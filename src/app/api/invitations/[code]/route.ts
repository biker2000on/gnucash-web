import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireAuth, requireRole } from '@/lib/auth';
import { getUserRoleForBook } from '@/lib/services/permission.service';

/**
 * GET /api/invitations/[code]
 * View invitation details (authenticated, any role).
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ code: string }> }
) {
    try {
        const authResult = await requireAuth();
        if (authResult instanceof NextResponse) return authResult;

        const { code } = await params;

        const rows = await prisma.$queryRaw<{
            id: number;
            code: string;
            book_guid: string;
            book_name: string | null;
            role: string;
            created_at: Date;
            expires_at: Date;
            use_count: number;
            max_uses: number;
            is_revoked: boolean;
            created_by_username: string;
        }[]>`
            SELECT
                i.id, i.code, i.book_guid,
                COALESCE(b.name, 'Unnamed Book') as book_name,
                r.name as role,
                i.created_at, i.expires_at,
                i.use_count, i.max_uses, i.is_revoked,
                u.username as created_by_username
            FROM gnucash_web_invitations i
            JOIN gnucash_web_roles r ON r.id = i.role_id
            JOIN gnucash_web_users u ON u.id = i.created_by
            LEFT JOIN books b ON b.guid = i.book_guid
            WHERE i.code = ${code}
            LIMIT 1
        `;

        if (rows.length === 0) {
            return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
        }

        const inv = rows[0];
        const isExpired = new Date(inv.expires_at) < new Date();
        const isMaxedOut = Number(inv.use_count) >= Number(inv.max_uses);

        if (inv.is_revoked || isExpired || isMaxedOut) {
            return NextResponse.json(
                {
                    error: inv.is_revoked ? 'Invitation has been revoked' :
                        isExpired ? 'Invitation has expired' :
                            'Invitation has reached maximum uses',
                    bookName: inv.book_name,
                    role: inv.role,
                },
                { status: 410 }
            );
        }

        return NextResponse.json({
            code: inv.code,
            bookGuid: inv.book_guid,
            bookName: inv.book_name,
            role: inv.role,
            createdBy: inv.created_by_username,
            expiresAt: inv.expires_at,
            usesRemaining: Number(inv.max_uses) - Number(inv.use_count),
        });
    } catch (error) {
        console.error('Error fetching invitation:', error);
        return NextResponse.json({ error: 'Failed to fetch invitation' }, { status: 500 });
    }
}

/**
 * DELETE /api/invitations/[code]
 * Revoke an invitation (admin of the book only).
 */
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ code: string }> }
) {
    try {
        const authResult = await requireAuth();
        if (authResult instanceof NextResponse) return authResult;

        const { code } = await params;
        const { user } = authResult;

        // Find the invitation to get book_guid
        const rows = await prisma.$queryRaw<{
            id: number;
            book_guid: string;
            is_revoked: boolean;
        }[]>`
            SELECT id, book_guid, is_revoked
            FROM gnucash_web_invitations
            WHERE code = ${code}
            LIMIT 1
        `;

        if (rows.length === 0) {
            return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
        }

        const inv = rows[0];

        // Verify admin of the book
        const userRole = await getUserRoleForBook(user.id, inv.book_guid);
        if (userRole !== 'admin') {
            return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
        }

        if (inv.is_revoked) {
            return NextResponse.json({ error: 'Invitation already revoked' }, { status: 410 });
        }

        await prisma.$executeRaw`
            UPDATE gnucash_web_invitations
            SET is_revoked = TRUE, revoked_by = ${user.id}, revoked_at = NOW()
            WHERE code = ${code}
        `;

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error revoking invitation:', error);
        return NextResponse.json({ error: 'Failed to revoke invitation' }, { status: 500 });
    }
}
