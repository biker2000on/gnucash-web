import { NextRequest, NextResponse } from 'next/server';
import { registerUser, createSession } from '@/lib/auth';
import { z } from 'zod';

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
