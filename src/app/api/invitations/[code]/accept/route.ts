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

        // Claim a use atomically. Checking use_count and then incrementing in a
        // second statement lets two concurrent redemptions both pass the check
        // and exceed max_uses; the conditional UPDATE makes the database the
        // arbiter. Claim before granting so a lost race grants nothing.
        const claimed = await prisma.$queryRaw<{
            book_guid: string;
            role: string;
            created_by: number;
        }[]>`
            WITH claimed AS (
                UPDATE gnucash_web_invitations
                SET use_count = use_count + 1, used_by = ${user.id}, used_at = NOW()
                WHERE code = ${code}
                  AND is_revoked = false
                  AND expires_at > NOW()
                  AND use_count < max_uses
                RETURNING book_guid, role_id, created_by
            )
            SELECT c.book_guid, r.name AS role, c.created_by
            FROM claimed c
            JOIN gnucash_web_roles r ON r.id = c.role_id
        `;

        if (claimed.length === 0) {
            // Nothing was claimed — say which precondition failed.
            const existing = await prisma.$queryRaw<{
                expires_at: Date;
                use_count: number;
                max_uses: number;
                is_revoked: boolean;
            }[]>`
                SELECT expires_at, use_count, max_uses, is_revoked
                FROM gnucash_web_invitations
                WHERE code = ${code}
                LIMIT 1
            `;

            if (existing.length === 0) {
                return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
            }
            const inv = existing[0];
            if (inv.is_revoked) {
                return NextResponse.json({ error: 'Invitation has been revoked' }, { status: 410 });
            }
            if (new Date(inv.expires_at) < new Date()) {
                return NextResponse.json({ error: 'Invitation has expired' }, { status: 410 });
            }
            return NextResponse.json({ error: 'Invitation has reached maximum uses' }, { status: 410 });
        }

        const inv = claimed[0];
        await grantRole(user.id, inv.book_guid, inv.role as Role, inv.created_by);

        return NextResponse.json({
            bookGuid: inv.book_guid,
            role: inv.role,
        });
    } catch (error) {
        console.error('Error accepting invitation:', error);
        return NextResponse.json({ error: 'Failed to accept invitation' }, { status: 500 });
    }
}
