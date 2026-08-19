import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for audit finding S1 (docs/audit-2026-08-03.md).
 *
 * This endpoint is unauthenticated — middleware exempts /api/auth/* — and it
 * used to grant `edit` on EVERY book to any caller, so a stranger could POST
 * once and read/write every tenant's books.
 */

const mocks = vi.hoisted(() => ({
    registerUser: vi.fn(),
    createSession: vi.fn(),
    grantRole: vi.fn(),
    count: vi.fn(),
    queryRaw: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    registerUser: mocks.registerUser,
    createSession: mocks.createSession,
}));
vi.mock('@/lib/services/permission.service', () => ({ grantRole: mocks.grantRole }));
vi.mock('@/lib/prisma', () => ({
    default: {
        gnucash_web_users: { count: mocks.count },
        $queryRaw: mocks.queryRaw,
    },
}));

import { POST } from './route';

function request(body: unknown): Parameters<typeof POST>[0] {
    return { json: vi.fn().mockResolvedValue(body) } as unknown as Parameters<typeof POST>[0];
}

const CREDENTIALS = { username: 'intruder', password: 'hunter2hunter2' };

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ALLOW_REGISTRATION;
    mocks.registerUser.mockResolvedValue({ id: 7, username: 'intruder' });
    mocks.createSession.mockResolvedValue(undefined);
    mocks.grantRole.mockResolvedValue(undefined);
    mocks.queryRaw.mockResolvedValue([{ guid: 'book-a' }, { guid: 'book-b' }]);
});

describe('POST /api/auth/register', () => {
    it('refuses to create an account once a user exists and registration is closed', async () => {
        mocks.count.mockResolvedValue(1);

        const response = await POST(request(CREDENTIALS));

        expect(response.status).toBe(403);
        expect(mocks.registerUser).not.toHaveBeenCalled();
        expect(mocks.grantRole).not.toHaveBeenCalled();
    });

    it('never grants book access to a self-registered account', async () => {
        process.env.ALLOW_REGISTRATION = 'true';
        // One user already exists, so the new account is not the bootstrap user.
        mocks.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

        const response = await POST(request(CREDENTIALS));

        expect(response.status).toBe(201);
        // The whole point: an account exists, but it can reach no book until it
        // accepts an invitation.
        expect(mocks.grantRole).not.toHaveBeenCalled();
    });

    it('bootstraps the very first user as admin so a fresh install is usable', async () => {
        mocks.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

        const response = await POST(request(CREDENTIALS));
        const body = await response.json();

        expect(response.status).toBe(201);
        expect(body.bootstrapped).toBe(true);
        expect(mocks.grantRole).toHaveBeenCalledTimes(2);
        for (const call of mocks.grantRole.mock.calls) {
            expect(call[2]).toBe('admin');
        }
    });

    it('still rejects a weak password', async () => {
        mocks.count.mockResolvedValue(0);

        const response = await POST(request({ username: 'someone', password: 'short' }));

        expect(response.status).toBe(400);
        expect(mocks.registerUser).not.toHaveBeenCalled();
    });

    // Regression: the route used to answer every failed parse with a generic
    // `error: 'Validation failed'`, and the shared client reader surfaces `error`
    // first — so the field-level detail in `errors` never reached the user.
    it('names the offending field in the top-level error string', async () => {
        mocks.count.mockResolvedValue(0);

        const response = await POST(request({ username: 'someone', password: 'short' }));
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error).toBe('password: Password must be at least 8 characters');
        expect(body.errors[0].path).toEqual(['password']);
    });
});
