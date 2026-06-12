import { describe, it, expect } from 'vitest';
import {
    resolveOidcUser,
    deriveUsername,
    hasVerifiedEmail,
    canUnlinkOidc,
    type OidcClaims,
    type OidcUserCandidate,
    type ResolveOidcInput,
} from '../oidc-resolve';

const ISSUER = 'https://id.example.com';

function claims(overrides: Partial<OidcClaims> = {}): OidcClaims {
    return {
        sub: 'sub-123',
        issuer: ISSUER,
        email: 'alice@example.com',
        emailVerified: true,
        preferredUsername: 'alice',
        name: 'Alice Example',
        ...overrides,
    };
}

function user(overrides: Partial<OidcUserCandidate> = {}): OidcUserCandidate {
    return {
        id: 1,
        username: 'alice',
        email: null,
        oidc_subject: null,
        oidc_issuer: null,
        hasPassword: true,
        ...overrides,
    };
}

function input(overrides: Partial<ResolveOidcInput> = {}): ResolveOidcInput {
    return {
        claims: claims(),
        userBySubject: null,
        userByEmail: null,
        userByUsername: null,
        takenUsernames: new Set<string>(),
        linkUser: null,
        ...overrides,
    };
}

describe('resolveOidcUser', () => {
    describe('subject match (returning OIDC user)', () => {
        it('logs in the user whose issuer+subject matches', () => {
            const existing = user({ id: 7, oidc_subject: 'sub-123', oidc_issuer: ISSUER });
            const result = resolveOidcUser(input({ userBySubject: existing }));
            expect(result).toEqual({ action: 'login', userId: 7 });
        });

        it('prefers subject match over email match', () => {
            const bySubject = user({ id: 7, oidc_subject: 'sub-123', oidc_issuer: ISSUER });
            const byEmail = user({ id: 8, email: 'alice@example.com' });
            const result = resolveOidcUser(input({ userBySubject: bySubject, userByEmail: byEmail }));
            expect(result).toEqual({ action: 'login', userId: 7 });
        });
    });

    describe('email auto-link (migration path)', () => {
        it('auto-links a manual user with a matching verified email', () => {
            const manual = user({ id: 3, email: 'alice@example.com' });
            const result = resolveOidcUser(input({ userByEmail: manual }));
            expect(result).toEqual({ action: 'auto-link', userId: 3 });
        });

        it('does not auto-link when the email is not verified', () => {
            const manual = user({ id: 3, email: 'alice@example.com' });
            const result = resolveOidcUser(
                input({
                    claims: claims({ emailVerified: false }),
                    userByEmail: null, // route never looks up unverified emails
                    takenUsernames: new Set(['alice']),
                    userByUsername: user({ id: 3, email: 'alice@example.com' }),
                })
            );
            // username owner has an email so the pending path does not apply either
            expect(result).toEqual({ action: 'create', username: 'alice2' });
            expect(manual.id).toBe(3);
        });

        it('does not steal an email-matched user already bound to a different OIDC identity', () => {
            const boundElsewhere = user({
                id: 3,
                email: 'alice@example.com',
                oidc_subject: 'other-sub',
                oidc_issuer: ISSUER,
            });
            const result = resolveOidcUser(
                input({ userByEmail: boundElsewhere, takenUsernames: new Set(['alice']) })
            );
            expect(result).toEqual({ action: 'create', username: 'alice2' });
        });
    });

    describe('username collision protection (no silent link)', () => {
        it('returns pending when a passworded local user squats the username with no email/oidc', () => {
            const local = user({ id: 4, username: 'alice', email: null, oidc_subject: null });
            const result = resolveOidcUser(
                input({ userByUsername: local, takenUsernames: new Set(['alice']) })
            );
            expect(result).toEqual({ action: 'pending', username: 'alice' });
        });

        it('creates a de-duped user when the username owner has an email (no match possible)', () => {
            const local = user({ id: 4, username: 'alice', email: 'other@example.com' });
            const result = resolveOidcUser(
                input({
                    claims: claims({ email: 'alice@example.com' }),
                    userByUsername: local,
                    takenUsernames: new Set(['alice']),
                })
            );
            expect(result).toEqual({ action: 'create', username: 'alice2' });
        });

        it('creates a de-duped user when the username owner is already OIDC-bound', () => {
            const local = user({ id: 4, username: 'alice', oidc_subject: 'someone-else' });
            const result = resolveOidcUser(
                input({ userByUsername: local, takenUsernames: new Set(['alice']) })
            );
            expect(result).toEqual({ action: 'create', username: 'alice2' });
        });
    });

    describe('new user creation', () => {
        it('creates a user with the preferred username when free', () => {
            const result = resolveOidcUser(input());
            expect(result).toEqual({ action: 'create', username: 'alice' });
        });

        it('de-dupes with numeric suffixes', () => {
            const result = resolveOidcUser(
                input({ takenUsernames: new Set(['alice', 'alice2', 'alice3']) })
            );
            expect(result).toEqual({ action: 'create', username: 'alice4' });
        });

        it('falls back to the email local part when preferred_username is absent', () => {
            const result = resolveOidcUser(
                input({ claims: claims({ preferredUsername: undefined, email: 'bob@example.com' }) })
            );
            expect(result).toEqual({ action: 'create', username: 'bob' });
        });
    });

    describe('link mode', () => {
        it('links the identity to the logged-in user', () => {
            const me = user({ id: 9 });
            const result = resolveOidcUser(input({ linkUser: me }));
            expect(result).toEqual({ action: 'link', userId: 9 });
        });

        it('is idempotent when the identity is already linked to me', () => {
            const me = user({ id: 9, oidc_subject: 'sub-123', oidc_issuer: ISSUER });
            const result = resolveOidcUser(input({ linkUser: me, userBySubject: me }));
            expect(result).toEqual({ action: 'link-already', userId: 9 });
        });

        it('conflicts when the identity belongs to another user', () => {
            const me = user({ id: 9 });
            const other = user({ id: 2, oidc_subject: 'sub-123', oidc_issuer: ISSUER });
            const result = resolveOidcUser(input({ linkUser: me, userBySubject: other }));
            expect(result).toMatchObject({ action: 'link-conflict' });
        });

        it('conflicts when my account is bound to a different identity', () => {
            const me = user({ id: 9, oidc_subject: 'different-sub', oidc_issuer: ISSUER });
            const result = resolveOidcUser(input({ linkUser: me }));
            expect(result).toMatchObject({ action: 'link-conflict' });
        });

        it('takes precedence over email auto-link', () => {
            const me = user({ id: 9 });
            const byEmail = user({ id: 3, email: 'alice@example.com' });
            const result = resolveOidcUser(input({ linkUser: me, userByEmail: byEmail }));
            expect(result).toEqual({ action: 'link', userId: 9 });
        });
    });
});

describe('deriveUsername', () => {
    it('sanitizes unsafe characters', () => {
        expect(
            deriveUsername(claims({ preferredUsername: 'al ice!@#' }), new Set())
        ).toBe('alice');
    });

    it('pads very short bases', () => {
        const name = deriveUsername(claims({ preferredUsername: 'a', email: undefined }), new Set());
        expect(name.length).toBeGreaterThanOrEqual(3);
    });

    it('falls back to "user" when nothing usable exists', () => {
        const name = deriveUsername(
            { sub: 's', issuer: ISSUER },
            new Set()
        );
        expect(name).toBe('user');
    });
});

describe('hasVerifiedEmail', () => {
    it('requires both email and explicit verification', () => {
        expect(hasVerifiedEmail(claims())).toBe(true);
        expect(hasVerifiedEmail(claims({ emailVerified: false }))).toBe(false);
        expect(hasVerifiedEmail(claims({ emailVerified: undefined }))).toBe(false);
        expect(hasVerifiedEmail(claims({ email: undefined }))).toBe(false);
    });
});

describe('canUnlinkOidc (lockout guard)', () => {
    it('allows unlink when a password is set', () => {
        expect(canUnlinkOidc({ hasPassword: true, oidc_subject: 'sub' })).toEqual({ ok: true });
    });

    it('refuses unlink for password-less users', () => {
        const result = canUnlinkOidc({ hasPassword: false, oidc_subject: 'sub' });
        expect(result.ok).toBe(false);
    });

    it('refuses unlink when nothing is linked', () => {
        const result = canUnlinkOidc({ hasPassword: true, oidc_subject: null });
        expect(result.ok).toBe(false);
    });
});
