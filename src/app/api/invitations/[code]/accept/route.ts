import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireAuth } from '@/lib/auth';
import { grantRole, type Role } from '@/lib/services/permission.service';

/**
 * POST /api/invitations/[code]/accept
 * Accept an invitation (authenticated).
 */
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ code: string }> }
) {
    try {
        const authResult = await requireAuth();
        if (authResult instanceof NextResponse) return authResult;

        const { code } = await params;
        const { user } = authResult;

        // Find the invitation
        const rows = await prisma.$queryRaw<{
            id: number;
            book_guid: string;
            role: string;
            expires_at: Date;
            use_count: number;
            max_uses: number;
            is_revoked: boolean;
            created_by: number;
        }[]>`
            SELECT
                i.id, i.book_guid, r.name as role,
                i.expires_at, i.use_count, i.max_uses,
                i.is_revoked, i.created_by
            FROM gnucash_web_invitations i
            JOIN gnucash_web_roles r ON r.id = i.role_id
            WHERE i.code = ${code}
            LIMIT 1
        `;

        if (rows.length === 0) {
            return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
        }

        const inv = rows[0];

        // Check if revoked
        if (inv.is_revoked) {
            return NextResponse.json({ error: 'Invitation has been revoked' }, { status: 410 });
        }

        // Check if expired
        if (new Date(inv.expires_at) < new Date()) {
            return NextResponse.json({ error: 'Invitation has expired' }, { status: 410 });
        }

        // Check if max uses exceeded
        if (Number(inv.use_count) >= Number(inv.max_uses)) {
            return NextResponse.json({ error: 'Invitation has reached maximum uses' }, { status: 410 });
        }

        // Grant the role
        await grantRole(user.id, inv.book_guid, inv.role as Role, inv.created_by);

        // Increment use count and record user
        await prisma.$executeRaw`
            UPDATE gnucash_web_invitations
            SET use_count = use_count + 1, used_by = ${user.id}, used_at = NOW()
            WHERE code = ${code}
        `;

        return NextResponse.json({
            bookGuid: inv.book_guid,
            role: inv.role,
        });
    } catch (error) {
        console.error('Error accepting invitation:', error);
        return NextResponse.json({ error: 'Failed to accept invitation' }, { status: 500 });
    }
}
