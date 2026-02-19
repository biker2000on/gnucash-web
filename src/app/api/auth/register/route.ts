import { NextRequest, NextResponse } from 'next/server';
import { registerUser, createSession } from '@/lib/auth';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { grantRole } from '@/lib/services/permission.service';

const RegisterSchema = z.object({
    username: z.string().min(3, 'Username must be at least 3 characters').max(50),
    password: z.string().min(8, 'Password must be at least 8 characters'),
});

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

        try {
            const user = await registerUser(username, password);
            await createSession(user.id, user.username);

            // Bootstrap RBAC: grant readonly on all existing books
            try {
                const books = await prisma.$queryRaw<{ guid: string }[]>`
                    SELECT guid FROM books
                `;
                for (const book of books) {
                    await grantRole(user.id, book.guid, 'readonly', user.id);
                }
            } catch (rbacError) {
                console.error('Failed to bootstrap RBAC for new user:', rbacError);
                // Don't fail registration if RBAC bootstrap fails
            }

            return NextResponse.json({
                success: true,
                user: { id: user.id, username: user.username },
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
