import { NextRequest, NextResponse } from 'next/server';
import { authenticateUser, createSession } from '@/lib/auth';
import { isTotpEnabled } from '@/lib/totp-store';
import { createTotpChallenge } from '@/lib/totp-challenge';
import {
    checkLoginAllowed,
    clearLoginFailures,
    clientIpFrom,
    recordLoginFailure,
} from '@/lib/login-throttle';
import { z } from 'zod';

const LoginSchema = z.object({
    username: z.string().min(1, 'Username is required'),
    password: z.string().min(1, 'Password is required'),
});

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const parseResult = LoginSchema.safeParse(body);

        if (!parseResult.success) {
            return NextResponse.json(
                { error: 'Validation failed', errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        const { username, password } = parseResult.data;
        const ip = clientIpFrom(request.headers);

        const throttle = await checkLoginAllowed(username, ip);
        if (!throttle.allowed) {
            return NextResponse.json(
                { error: 'Too many failed attempts. Try again shortly.' },
                {
                    status: 429,
                    headers: { 'Retry-After': String(throttle.retryAfterSeconds) },
                }
            );
        }

        const user = await authenticateUser(username, password);

        if (!user) {
            await recordLoginFailure(username, ip);
            return NextResponse.json(
                { error: 'Invalid username or password' },
                { status: 401 }
            );
        }

        await clearLoginFailures(username, ip);

        // Strictly opt-in 2FA: only users who explicitly enrolled get the
        // TOTP step. Everyone else follows the exact same path as before.
        if (await isTotpEnabled(user.id)) {
            await createTotpChallenge(user.id, user.username);
            return NextResponse.json({ totpRequired: true });
        }

        await createSession(user.id, user.username);

        return NextResponse.json({
            success: true,
            user: { id: user.id, username: user.username },
        });
    } catch (error) {
        console.error('Login error:', error);
        return NextResponse.json(
            { error: 'Login failed' },
            { status: 500 }
        );
    }
}
