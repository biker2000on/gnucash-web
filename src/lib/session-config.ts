import { SessionOptions } from 'iron-session';

// Session data structure
export interface SessionData {
    userId?: number;
    username?: string;
    isLoggedIn: boolean;
    activeBookGuid?: string;
}

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

/** iron-session refuses anything shorter; a weak key here forges any session. */
const MIN_SECRET_LENGTH = 32;

function resolveSessionSecret(): string {
    const secret = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET;
    if (!secret) {
        throw new Error(
            'SESSION_SECRET (or NEXTAUTH_SECRET) must be set. Session cookies are sealed ' +
            'with it; without one, anyone could mint an authenticated cookie. ' +
            'Generate one with: openssl rand -base64 32'
        );
    }
    if (secret.length < MIN_SECRET_LENGTH) {
        throw new Error(
            `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got ${secret.length}).`
        );
    }
    return secret;
}

// Session configuration -- shared between middleware and auth.ts
export const sessionOptions: SessionOptions = {
    password: resolveSessionSecret(),
    cookieName: 'gnucash_web_session',
    cookieOptions: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: SESSION_MAX_AGE_SECONDS,
    },
};
