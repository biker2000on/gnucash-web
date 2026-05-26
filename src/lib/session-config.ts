import { SessionOptions } from 'iron-session';

// Session data structure
export interface SessionData {
    userId?: number;
    username?: string;
    isLoggedIn: boolean;
    activeBookGuid?: string;
}

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

// Session configuration -- shared between middleware and auth.ts
export const sessionOptions: SessionOptions = {
    password: process.env.SESSION_SECRET || 'complex_password_at_least_32_characters_long_12345',
    cookieName: 'gnucash_web_session',
    cookieOptions: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: SESSION_MAX_AGE_SECONDS,
    },
};
