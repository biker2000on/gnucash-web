/**
 * POST /api/auth/totp/verify — second step of password login for users who
 * opted into TOTP.
 *
 * SECURITY: /api/auth/* is public in the middleware, so this route
 * authenticates itself via the pending challenge stored in the signed
 * iron-session cookie by /api/auth/login (createTotpChallenge). Without a
 * live, unexpired challenge, it always returns 401. Attempts are limited
 * to TOTP_MAX_ATTEMPTS per challenge; exhausting them kills the challenge
 * and forces a fresh password login.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createSession } from '@/lib/auth';
import { verifyLogin } from '@/lib/totp-store';
import {
    readTotpChallenge,
    clearTotpChallenge,
    recordAttempt,
    TOTP_MAX_ATTEMPTS,
} from '@/lib/totp-challenge';

const VerifySchema = z.object({
    code: z.string().min(1, 'Code is required').max(64),
});

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const parseResult = VerifySchema.safeParse(body);
        if (!parseResult.success) {
            return NextResponse.json(
                { error: 'Validation failed', errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        const challenge = await readTotpChallenge();
        if (!challenge) {
            return NextResponse.json(
                { error: 'Your sign-in session has expired. Please log in again.', challengeExpired: true },
                { status: 401 }
            );
        }

        const attempts = recordAttempt(challenge.challengeId, challenge.expiresAt);
        if (attempts > TOTP_MAX_ATTEMPTS) {
            await clearTotpChallenge();
            return NextResponse.json(
                { error: 'Too many attempts. Please log in again.', challengeExpired: true },
                { status: 429 }
            );
        }

        const ok = await verifyLogin(challenge.userId, parseResult.data.code);
        if (!ok) {
            const remaining = TOTP_MAX_ATTEMPTS - attempts;
            if (remaining <= 0) {
                await clearTotpChallenge();
                return NextResponse.json(
                    { error: 'Too many attempts. Please log in again.', challengeExpired: true },
                    { status: 429 }
                );
            }
            return NextResponse.json(
                { error: 'Invalid code. Please try again.', attemptsRemaining: remaining },
                { status: 401 }
            );
        }

        // Success: drop the challenge, then create the session exactly the
        // way a non-TOTP login does.
        await clearTotpChallenge();
        await createSession(challenge.userId, challenge.username);

        return NextResponse.json({
            success: true,
            user: { id: challenge.userId, username: challenge.username },
        });
    } catch (error) {
        console.error('TOTP verify error:', error);
        return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
    }
}
