import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { grantRole, revokeAccess, type Role } from '@/lib/services/permission.service';

const VALID_ROLES: Role[] = ['readonly', 'edit', 'admin', 'timekeeper'];

/** Number of admins on a book. */
async function countAdmins(bookGuid: string): Promise<number> {
    return prisma.gnucash_web_book_permissions.count({
        where: { book_guid: bookGuid, role: { name: 'admin' } },
    });
}

/**
 * PUT /api/books/[guid]/users/[userId]
 * Change a user's role for this book (admin only).
 * Refuses to demote the last remaining admin.
 */
export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string; userId: string }> }
) {
    try {
        const roleResult = await requireRole('admin');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid, userId: userIdParam } = await params;
        const userId = Number(userIdParam);
        if (!Number.isInteger(userId)) {
            return NextResponse.json({ error: 'Invalid user id' }, { status: 400 });
        }

        // requireRole authorizes against the *active* book; make sure the
        // admin actually administers the book in the URL.
        if (roleResult.bookGuid !== guid) {
            const urlBookRole = await prisma.gnucash_web_book_permissions.findFirst({
                where: { user_id: roleResult.user.id, book_guid: guid, role: { name: 'admin' } },
                select: { id: true },
            });
            if (!urlBookRole) {
                return NextResponse.json({ error: 'Admin access required for this book' }, { status: 403 });
            }
        }

        const body = await request.json().catch(() => null);
        const newRole = body?.role as Role | undefined;
        if (!newRole || !VALID_ROLES.includes(newRole)) {
            return NextResponse.json(
                { error: `Role must be one of: ${VALID_ROLES.join(', ')}` },
                { status: 400 }
            );
        }

        const existing = await prisma.gnucash_web_book_permissions.findFirst({
            where: { user_id: userId, book_guid: guid },
            include: { role: true },
        });
        if (!existing) {
            return NextResponse.json({ error: 'User has no access to this book' }, { status: 404 });
        }

        // Last-admin guard: cannot demote the only admin of the book
        if (existing.role.name === 'admin' && newRole !== 'admin') {
            const admins = await countAdmins(guid);
            if (admins <= 1) {
                return NextResponse.json(
                    { error: 'Cannot demote the last admin of this book' },
                    { status: 400 }
                );
            }
        }

        await grantRole(userId, guid, newRole, roleResult.user.id);

        return NextResponse.json({ success: true, userId, role: newRole });
    } catch (error) {
        console.error('Error updating user role:', error);
        return NextResponse.json({ error: 'Failed to update role' }, { status: 500 });
    }
}

/**
 * DELETE /api/books/[guid]/users/[userId]
 * Revoke a user's access to this book (admin only). Last-admin guarded.
 */
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string; userId: string }> }
) {
    try {
        const roleResult = await requireRole('admin');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid, userId: userIdParam } = await params;
        const userId = Number(userIdParam);
        if (!Number.isInteger(userId)) {
            return NextResponse.json({ error: 'Invalid user id' }, { status: 400 });
        }

        if (roleResult.bookGuid !== guid) {
            const urlBookRole = await prisma.gnucash_web_book_permissions.findFirst({
                where: { user_id: roleResult.user.id, book_guid: guid, role: { name: 'admin' } },
                select: { id: true },
            });
            if (!urlBookRole) {
                return NextResponse.json({ error: 'Admin access required for this book' }, { status: 403 });
            }
        }

        const existing = await prisma.gnucash_web_book_permissions.findFirst({
            where: { user_id: userId, book_guid: guid },
            include: { role: true },
        });
        if (!existing) {
            return NextResponse.json({ error: 'User has no access to this book' }, { status: 404 });
        }

        if (existing.role.name === 'admin') {
            const admins = await countAdmins(guid);
            if (admins <= 1) {
                return NextResponse.json(
                    { error: 'Cannot remove the last admin of this book' },
                    { status: 400 }
                );
            }
        }

        await revokeAccess(userId, guid);
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error revoking user access:', error);
        return NextResponse.json({ error: 'Failed to revoke access' }, { status: 500 });
    }
}
