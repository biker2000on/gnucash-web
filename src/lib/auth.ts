/**
 * Authentication Utilities
 *
 * Provides password hashing, session management, and user authentication
 * using bcrypt and iron-session.
 */

import bcrypt from 'bcrypt';
import { getIronSession, IronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import prisma from './prisma';
import { SessionData, sessionOptions } from './session-config';
import { getUserRoleForBook, type Role } from './services/permission.service';

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

    if (!user) {
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
 * Require a minimum role for the active book. Returns user + role or error response.
 * The middleware guarantees authentication; this function adds authorization.
 */
export async function requireRole(minimumRole: Role): Promise<
  { user: { id: number; username: string }; role: Role; bookGuid: string } |
  NextResponse
> {
    const authResult = await requireAuth();
    if (authResult instanceof NextResponse) return authResult;

    const { user, session } = authResult;
    const bookGuid = session.activeBookGuid;

    if (!bookGuid) {
        return NextResponse.json({ error: 'No active book selected' }, { status: 400 });
    }

    const userRole = await getUserRoleForBook(user.id, bookGuid);
    if (!userRole) {
        return NextResponse.json({ error: 'No access to this book' }, { status: 403 });
    }

    const ROLE_HIERARCHY: Record<string, number> = { readonly: 0, edit: 1, admin: 2 };
    if (ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY[minimumRole]) {
        return NextResponse.json(
            { error: `Requires ${minimumRole} role, you have ${userRole}` },
            { status: 403 }
        );
    }

    return { user, role: userRole, bookGuid };
}
