/**
 * Pure decision logic for the OIDC callback. Extracted from the route handler
 * so the account-resolution rules (login, auto-link, username-squat protection,
 * new-user creation, link mode) are unit-testable without a database.
 */

export interface OidcClaims {
    /** Stable subject identifier from the provider. */
    sub: string;
    /** Issuer URL the token was validated against. */
    issuer: string;
    email?: string;
    /** Only `true` counts as verified; absent/false emails are never used for auto-linking. */
    emailVerified?: boolean;
    preferredUsername?: string;
    name?: string;
    picture?: string;
}

/** Minimal user shape the resolver needs. */
export interface OidcUserCandidate {
    id: number;
    username: string;
    email: string | null;
    oidc_subject: string | null;
    oidc_issuer: string | null;
    hasPassword: boolean;
}

export interface ResolveOidcInput {
    claims: OidcClaims;
    /** User whose (oidc_issuer, oidc_subject) matches the claims, if any. */
    userBySubject: OidcUserCandidate | null;
    /** User whose stored email matches the (verified) OIDC email, if any. */
    userByEmail: OidcUserCandidate | null;
    /** User whose username exactly matches preferred_username, if any. */
    userByUsername: OidcUserCandidate | null;
    /** All usernames currently taken (used for de-duping new usernames). */
    takenUsernames: Set<string>;
    /** Link mode: the currently logged-in user requesting to attach this identity. */
    linkUser?: OidcUserCandidate | null;
}

export type ResolveOidcAction =
    | { action: 'login'; userId: number }
    | { action: 'auto-link'; userId: number }
    | { action: 'link'; userId: number }
    | { action: 'link-already'; userId: number }
    | { action: 'link-conflict'; reason: string }
    | { action: 'pending'; username: string }
    | { action: 'create'; username: string };

/** Email is usable for matching/storing only when explicitly verified. */
export function hasVerifiedEmail(claims: OidcClaims): boolean {
    return Boolean(claims.email) && claims.emailVerified === true;
}

const USERNAME_SANITIZE = /[^a-zA-Z0-9._-]/g;

/**
 * Derive a unique username for a brand-new OIDC user.
 * Base preference: preferred_username, then email local part, then "user".
 * De-dupes with numeric suffixes: name, name2, name3, ...
 */
export function deriveUsername(claims: OidcClaims, taken: Set<string>): string {
    let base =
        claims.preferredUsername?.trim() ||
        claims.email?.split('@')[0]?.trim() ||
        'user';
    base = base.replace(USERNAME_SANITIZE, '').slice(0, 50);
    if (base.length < 3) base = `user-${base}`.replace(/-$/, '').padEnd(3, '0');

    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
        const candidate = `${base}${i}`.slice(0, 50);
        if (!taken.has(candidate)) return candidate;
    }
    // Practically unreachable; fall back to a time-based suffix.
    return `${base.slice(0, 36)}-${Date.now().toString(36)}`;
}

export function resolveOidcUser(input: ResolveOidcInput): ResolveOidcAction {
    const { claims, userBySubject, userByEmail, userByUsername, takenUsernames, linkUser } = input;

    // ---- Link mode: attach this identity to the logged-in user ----
    if (linkUser) {
        if (userBySubject) {
            if (userBySubject.id === linkUser.id) {
                return { action: 'link-already', userId: linkUser.id };
            }
            return {
                action: 'link-conflict',
                reason: 'This identity is already linked to another account',
            };
        }
        if (linkUser.oidc_subject && linkUser.oidc_subject !== claims.sub) {
            return {
                action: 'link-conflict',
                reason: 'Your account is already linked to a different identity',
            };
        }
        return { action: 'link', userId: linkUser.id };
    }

    // ---- (b) Existing user with matching (issuer, subject): log in ----
    if (userBySubject) {
        return { action: 'login', userId: userBySubject.id };
    }

    // ---- (c) Migration path: verified email matches an existing account ----
    if (hasVerifiedEmail(claims) && userByEmail) {
        if (userByEmail.oidc_subject) {
            // The email owner is bound to a *different* OIDC identity. Do not
            // hijack it — treat this login as a brand-new user instead.
            return { action: 'create', username: deriveUsername(claims, takenUsernames) };
        }
        return { action: 'auto-link', userId: userByEmail.id };
    }

    // ---- (d) Username squat protection: never silently link by username ----
    if (
        claims.preferredUsername &&
        userByUsername &&
        !userByUsername.email &&
        !userByUsername.oidc_subject
    ) {
        return { action: 'pending', username: userByUsername.username };
    }

    // ---- (e) New user ----
    return { action: 'create', username: deriveUsername(claims, takenUsernames) };
}

/**
 * Guard for unlinking: a user may only remove their OIDC identity when a
 * password remains, otherwise they would be locked out.
 */
export function canUnlinkOidc(user: { hasPassword: boolean; oidc_subject: string | null }):
    | { ok: true }
    | { ok: false; reason: string } {
    if (!user.oidc_subject) {
        return { ok: false, reason: 'No identity provider is linked to this account' };
    }
    if (!user.hasPassword) {
        return {
            ok: false,
            reason: 'Set a password before unlinking, or you would be locked out',
        };
    }
    return { ok: true };
}
