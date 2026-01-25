/**
 * Authentication Utilities
 *
 * Provides password hashing, session management, and user authentication
 * using bcrypt and iron-session.
 */

import bcrypt from 'bcrypt';
import { getIronSession, IronSession, SessionOptions } from 'iron-session';
import { cookies } from 'next/headers';
import prisma from './prisma';

const SALT_ROUNDS = 10;

// Session data structure
export interface SessionData {
    userId?: number;
    username?: string;
    isLoggedIn: boolean;
}

// Session configuration
const sessionOptions: SessionOptions = {
    password: process.env.SESSION_SECRET || 'complex_password_at_least_32_characters_long_12345',
    cookieName: 'gnucash_web_session',
    cookieOptions: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24, // 24 hours
    },
};

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
