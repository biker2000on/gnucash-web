/**
 * Authentication Utilities
 *
 * Provides password hashing, session management, and user authentication
 * using bcrypt and iron-session.
 */

import bcrypt from 'bcrypt';
import { getIronSession, IronSession } from 'iron-session';
import { cookies, headers } from 'next/headers';
import { NextResponse } from 'next/server';
import prisma from './prisma';
import { SessionData, sessionOptions } from './session-config';
import { getUserRoleForBook, roleAtLeast, hasTimesheetAccess, type Role } from './services/permission.service';
import { authenticateBearer, parseBearerToken } from './api-tokens';

export type { SessionData };
export type { Role };

const SALT_ROUNDS = 10;

/**
 * Get the current session
 */
export async function getSession(): Promise<IronSession<SessionData>> {
    const cookieStore = await cookies();
    return getIronSession<SessionData>(cookieStore, sessionOptions);
}

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
}

/**
 * Create a session for a user
 */
export async function createSession(userId: number, username: string): Promise<void> {
    const session = await getSession();
    session.userId = userId;
    session.username = username;
    session.isLoggedIn = true;
    await session.save();
}

/**
 * Destroy the current session
 */
export async function destroySession(): Promise<void> {
    const session = await getSession();
    session.destroy();
}

/**
 * Get the current user from session
 */
export async function getCurrentUser(): Promise<{ id: number; username: string } | null> {
    const session = await getSession();

    if (!session.isLoggedIn || !session.userId) {
        return null;
    }

    const user = await prisma.gnucash_web_users.findUnique({
        where: { id: session.userId },
        select: { id: true, username: true },
    });

    if (user) {
        await session.save();
    }

    return user;
}

/**
 * Check if the current request is authenticated
 */
export async function isAuthenticated(): Promise<boolean> {
    const session = await getSession();
    return session.isLoggedIn === true && !!session.userId;
}

/**
 * Register a new user
 */
export async function registerUser(username: string, password: string): Promise<{ id: number; username: string }> {
    // Check if username already exists
    const existing = await prisma.gnucash_web_users.findUnique({
        where: { username },
    });

    if (existing) {
        throw new Error('Username already taken');
    }

    // Hash password and create user
    const passwordHash = await hashPassword(password);

    const user = await prisma.gnucash_web_users.create({
        data: {
            username,
            password_hash: passwordHash,
        },
        select: { id: true, username: true },
    });

    return user;
}

/**
 * Authenticate a user with username and password
 */
export async function authenticateUser(username: string, password: string): Promise<{ id: number; username: string } | null> {
    const user = await prisma.gnucash_web_users.findUnique({
        where: { username },
    });

    // OIDC-only users have no password and cannot log in with one
    if (!user || !user.password_hash) {
        return null;
    }

    const isValid = await verifyPassword(password, user.password_hash);

    if (!isValid) {
        return null;
    }

    // Update last login
    await prisma.gnucash_web_users.update({
        where: { id: user.id },
        data: { last_login: new Date() },
    });

    return { id: user.id, username: user.username };
}

/**
 * Require authentication. Returns user or 401 response.
 * Used in API route handlers (middleware already checked auth,
 * but this provides the user object + active book context).
 */
export async function requireAuth(): Promise<
  { user: { id: number; username: string }; session: IronSession<SessionData> } |
  NextResponse
> {
    const session = await getSession();
    if (!session.isLoggedIn || !session.userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    await session.save();
    const user = await prisma.gnucash_web_users.findUnique({
        where: { id: session.userId },
        select: { id: true, username: true },
    });
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return { user, session };
}

/**
 * Read a `gcw_...` API token from the request's Authorization header,
 * or null when absent / not in a request scope.
 */
async function getBearerApiToken(): Promise<string | null> {
    try {
        const headerStore = await headers();
        return parseBearerToken(headerStore.get('authorization'));
    } catch {
        // headers() throws outside a request scope (e.g. build time)
        return null;
    }
}

/**
 * Require a minimum role for the active book. Returns user + role or error response.
 * The middleware guarantees authentication; this function adds authorization.
 * Also accepts `Authorization: Bearer gcw_...` personal access tokens — in
 * that case `viaToken: true` is set on the result and the effective role is
 * capped at the token's role.
 */
export async function requireRole(minimumRole: Role): Promise<
  { user: { id: number; username: string }; role: Role; bookGuid: string; viaToken?: boolean } |
  NextResponse
> {
    // --- API token (Bearer gcw_...) path -------------------------------
    // Personal access tokens bypass the session entirely. The effective
    // role is capped at BOTH the token's role and the user's actual role
    // for the book (a token can narrow permissions, never escalate).
    const bearerToken = await getBearerApiToken();
    if (bearerToken) {
        const tokenAuth = await authenticateBearer(bearerToken);
        if (!tokenAuth) {
            return NextResponse.json({ error: 'Invalid or expired API token' }, { status: 401 });
        }
        // Fail closed: an unknown role name must never authorize (a raw
        // `HIERARCHY[role] < HIERARCHY[min]` compare is false for undefined,
        // which would skip this rejection and allow the request through).
        if (!roleAtLeast(tokenAuth.role, minimumRole)) {
            return NextResponse.json(
                { error: `Requires ${minimumRole} role, this token grants ${tokenAuth.role}` },
                { status: 403 }
            );
        }
        return { user: tokenAuth.user, role: tokenAuth.role, bookGuid: tokenAuth.bookGuid, viaToken: true };
    }

    // --- Session (cookie) path — unchanged ------------------------------
    const authResult = await requireAuth();
    if (authResult instanceof NextResponse) return authResult;

    const { user, session } = authResult;
    let bookGuid = session.activeBookGuid;

    // If no active book in session, fall back to the first available book
    if (!bookGuid) {
        const firstBook = await prisma.books.findFirst({ select: { guid: true } });
        if (!firstBook) {
            return NextResponse.json({ error: 'No active book selected' }, { status: 400 });
        }
        bookGuid = firstBook.guid;
        session.activeBookGuid = bookGuid;
        await session.save();
    }

    const userRole = await getUserRoleForBook(user.id, bookGuid);
    if (!userRole) {
        return NextResponse.json({ error: 'No access to this book' }, { status: 403 });
    }

    // Fail closed: unknown roles (and 'timekeeper', which sits outside the
    // financial hierarchy) are rejected — see roleAtLeast().
    if (!roleAtLeast(userRole, minimumRole)) {
        return NextResponse.json(
            { error: `Requires ${minimumRole} role, you have ${userRole}` },
            { status: 403 }
        );
    }

    return { user, role: userRole, bookGuid };
}

/**
 * Authorize access to time-tracking endpoints for the active book.
 *
 * Write access: timekeeper, edit, or admin. Read access additionally accepts
 * readonly. `isTimekeeper` is true when the effective role is the restricted
 * 'timekeeper' role — callers MUST then scope all reads and mutations to the
 * calling user's own entries.
 *
 * Also accepts `Authorization: Bearer gcw_...` API tokens (token roles are
 * readonly/edit/admin, never timekeeper).
 */
export async function requireTimesheetRole(access: 'read' | 'write' = 'write'): Promise<
  { user: { id: number; username: string }; role: Role; bookGuid: string; isTimekeeper: boolean; viaToken?: boolean } |
  NextResponse
> {
    // --- API token (Bearer gcw_...) path -------------------------------
    const bearerToken = await getBearerApiToken();
    if (bearerToken) {
        const tokenAuth = await authenticateBearer(bearerToken);
        if (!tokenAuth) {
            return NextResponse.json({ error: 'Invalid or expired API token' }, { status: 401 });
        }
        if (!hasTimesheetAccess(tokenAuth.role, access)) {
            return NextResponse.json(
                { error: `Time tracking requires ${access} access, this token grants ${tokenAuth.role}` },
                { status: 403 }
            );
        }
        return {
            user: tokenAuth.user,
            role: tokenAuth.role,
            bookGuid: tokenAuth.bookGuid,
            isTimekeeper: tokenAuth.role === 'timekeeper',
            viaToken: true,
        };
    }

    // --- Session (cookie) path ------------------------------------------
    const authResult = await requireAuth();
    if (authResult instanceof NextResponse) return authResult;

    const { user, session } = authResult;
    let bookGuid = session.activeBookGuid;
    if (!bookGuid) {
        const firstBook = await prisma.books.findFirst({ select: { guid: true } });
        if (!firstBook) {
            return NextResponse.json({ error: 'No active book selected' }, { status: 400 });
        }
        bookGuid = firstBook.guid;
        session.activeBookGuid = bookGuid;
        await session.save();
    }

    const userRole = await getUserRoleForBook(user.id, bookGuid);
    if (!userRole) {
        return NextResponse.json({ error: 'No access to this book' }, { status: 403 });
    }
    if (!hasTimesheetAccess(userRole, access)) {
        return NextResponse.json(
            { error: `Time tracking requires ${access} access, you have ${userRole}` },
            { status: 403 }
        );
    }

    return { user, role: userRole, bookGuid, isTimekeeper: userRole === 'timekeeper' };
}
