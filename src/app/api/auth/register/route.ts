import { NextRequest, NextResponse } from 'next/server';
import { registerUser, createSession } from '@/lib/auth';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { grantRole } from '@/lib/services/permission.service';

const RegisterSchema = z.object({
    username: z.string().min(3, 'Username must be at least 3 characters').max(50),
    password: z.string().min(8, 'Password must be at least 8 characters'),
});

/** Opt-in flag for open self-registration. Absent means closed. */
function registrationIsOpen(): boolean {
    return process.env.ALLOW_REGISTRATION === 'true';
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const parseResult = RegisterSchema.safeParse(body);

        if (!parseResult.success) {
            return NextResponse.json(
                { error: 'Validation failed', errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        const { username, password } = parseResult.data;

        // This endpoint is unauthenticated (middleware exempts /api/auth/*), so it
        // is only open for first-run setup or when an operator explicitly opts in.
        const existingUsers = await prisma.gnucash_web_users.count();
        if (existingUsers > 0 && !registrationIsOpen()) {
            return NextResponse.json(
                {
                    error:
                        'Registration is disabled. Ask an administrator to send you an invitation link.',
                },
                { status: 403 }
            );
        }

        try {
            const user = await registerUser(username, password);
            await createSession(user.id, user.username);

            // First-run bootstrap only. Granting roles here for anyone else would
            // let a self-registered account reach books it was never invited to;
            // every other user receives access through an invitation, which
            // carries its own book and role.
            const totalUsers = await prisma.gnucash_web_users.count();
            const isBootstrapUser = totalUsers === 1;

            if (isBootstrapUser) {
                try {
                    const books = await prisma.$queryRaw<{ guid: string }[]>`
                        SELECT guid FROM books
                    `;
                    for (const book of books) {
                        await grantRole(user.id, book.guid, 'admin', user.id);
                    }
                } catch (rbacError) {
                    console.error('Failed to bootstrap RBAC for first user:', rbacError);
                    // Don't fail registration if RBAC bootstrap fails
                }
            }

            return NextResponse.json({
                success: true,
                user: { id: user.id, username: user.username },
                bootstrapped: isBootstrapUser,
            }, { status: 201 });
        } catch (err) {
            if (err instanceof Error && err.message === 'Username already taken') {
                return NextResponse.json(
                    { error: 'Username already taken' },
                    { status: 409 }
                );
            }
            throw err;
        }
    } catch (error) {
        console.error('Registration error:', error);
        return NextResponse.json(
            { error: 'Registration failed' },
            { status: 500 }
        );
    }
}
