/**
 * Pending-login TOTP challenge.
 *
 * When a user with TOTP enabled passes the password check, we do NOT create
 * a full session. Instead we store a short-lived "pending" marker in the
 * same iron-session cookie (signed + encrypted by iron-session, so the
 * client cannot forge or read it). The middleware only honours
 * `isLoggedIn === true`, which is explicitly kept false here, so a pending
 * challenge grants zero access.
 *
 * The extra fields are declared on a local extension of SessionData rather
 * than in session-config.ts so this feature stays fully self-contained.
 * iron-session is schemaless at runtime — the same cookie/secret is used.
 *
 * Verify attempts are rate-limited to TOTP_MAX_ATTEMPTS per challenge via
 * an in-memory counter keyed by a random challenge id (regenerated on every
 * password login, so replaying an old cookie cannot reset the counter
 * within a challenge).
 */

import crypto from 'crypto';
import { getIronSession, IronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { SessionData, sessionOptions } from './session-config';

export const TOTP_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const TOTP_MAX_ATTEMPTS = 5;

interface TotpChallengeSessionData extends SessionData {
    pendingTotpUserId?: number;
    pendingTotpUsername?: string;
    /** Epoch ms after which the challenge is dead. */
    pendingTotpExpiresAt?: number;
    /** Random id tying the challenge to its server-side attempt counter. */
    pendingTotpChallengeId?: string;
}

async function getChallengeSession(): Promise<IronSession<TotpChallengeSessionData>> {
    const cookieStore = await cookies();
    return getIronSession<TotpChallengeSessionData>(cookieStore, sessionOptions);
}

// --- attempt counter (in-memory; single-instance deployment) ---------------

const attemptsByChallenge = new Map<string, { count: number; expiresAt: number }>();

function pruneAttempts(): void {
    const now = Date.now();
    for (const [id, entry] of attemptsByChallenge) {
        if (entry.expiresAt < now) attemptsByChallenge.delete(id);
    }
}

/** Record one verify attempt; returns the total attempts for this challenge. */
export function recordAttempt(challengeId: string, expiresAt: number): number {
    pruneAttempts();
    const entry = attemptsByChallenge.get(challengeId) ?? { count: 0, expiresAt };
    entry.count += 1;
    attemptsByChallenge.set(challengeId, entry);
    return entry.count;
}

export function clearAttempts(challengeId: string): void {
    attemptsByChallenge.delete(challengeId);
}

// --- challenge lifecycle ----------------------------------------------------

/**
 * Store a pending TOTP challenge in the session cookie after a successful
 * password check. Explicitly ensures the session is NOT logged in.
 */
export async function createTotpChallenge(userId: number, username: string): Promise<void> {
    const session = await getChallengeSession();
    session.isLoggedIn = false;
    session.userId = undefined;
    session.username = undefined;
    session.pendingTotpUserId = userId;
    session.pendingTotpUsername = username;
    session.pendingTotpExpiresAt = Date.now() + TOTP_CHALLENGE_TTL_MS;
    session.pendingTotpChallengeId = crypto.randomBytes(16).toString('hex');
    await session.save();
}

export interface TotpChallenge {
    userId: number;
    username: string;
    challengeId: string;
    expiresAt: number;
}

/**
 * Read the current pending challenge, or null when absent/expired.
 * Expired challenges are cleared from the cookie as a side effect.
 */
export async function readTotpChallenge(): Promise<TotpChallenge | null> {
    const session = await getChallengeSession();
    const { pendingTotpUserId, pendingTotpUsername, pendingTotpExpiresAt, pendingTotpChallengeId } = session;
    if (!pendingTotpUserId || !pendingTotpUsername || !pendingTotpExpiresAt || !pendingTotpChallengeId) {
        return null;
    }
    if (Date.now() > pendingTotpExpiresAt) {
        await clearTotpChallenge();
        return null;
    }
    return {
        userId: pendingTotpUserId,
        username: pendingTotpUsername,
        challengeId: pendingTotpChallengeId,
        expiresAt: pendingTotpExpiresAt,
    };
}

/** Remove the pending challenge fields from the session cookie. */
export async function clearTotpChallenge(): Promise<void> {
    const session = await getChallengeSession();
    if (session.pendingTotpChallengeId) {
        clearAttempts(session.pendingTotpChallengeId);
    }
    session.pendingTotpUserId = undefined;
    session.pendingTotpUsername = undefined;
    session.pendingTotpExpiresAt = undefined;
    session.pendingTotpChallengeId = undefined;
    await session.save();
}
