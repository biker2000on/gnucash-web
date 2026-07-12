import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { db, getUserRoleForBookMock } = vi.hoisted(() => ({
    db: {
        $queryRaw: vi.fn(),
        $executeRaw: vi.fn(),
        $executeRawUnsafe: vi.fn(),
        gnucash_web_users: { findUnique: vi.fn() },
        gnucash_web_book_permissions: { findFirst: vi.fn() },
    },
    getUserRoleForBookMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: db }));
vi.mock('@/lib/services/permission.service', () => ({
    getUserRoleForBook: getUserRoleForBookMock,
}));

import {
    generateTokenSecret,
    hashToken,
    isValidTokenFormat,
    parseBearerToken,
    capRole,
    constantTimeEqualHex,
    resolveToken,
    authenticateBearer,
    TOKEN_PREFIX,
} from '../api-tokens';
import {
    eventMatches,
    parseEvents,
    serializeEvents,
    signPayload,
    validateWebhookUrl,
    buildWebhookBody,
    deliverToWebhook,
    deliverWebhooks,
} from '../webhooks';

// Known vectors (precomputed with node:crypto)
const KNOWN_SECRET = 'gcw_0123456789abcdef0123456789abcdef';
const KNOWN_SECRET_SHA256 = 'fcadef1ad1ccc66220296e62cfbda3ea89730240bda4a1b3cd696d20e48635e6';
const HMAC_KEY = 'whsec_test123';
const HMAC_BODY = '{"id":1,"type":"budget_alert","title":"Test"}';
const HMAC_EXPECTED = 'sha256=f9c11f8e8f2eb7fbcc2afbcebbc73ca2db82bb959bf21f54947a73e5a64a5db3';

function tokenRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        user_id: 7,
        name: 'test token',
        token_hash: KNOWN_SECRET_SHA256,
        prefix: 'gcw_0123',
        role: 'edit',
        book_guid: 'book1234book1234book1234book1234',
        expires_at: null,
        last_used_at: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        revoked_at: null,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    db.$executeRawUnsafe.mockResolvedValue(0);
    db.$executeRaw.mockResolvedValue(1);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Token format & hashing
// ---------------------------------------------------------------------------

describe('token format and hashing', () => {
    it('generates gcw_ + 32 lowercase hex chars', () => {
        for (let i = 0; i < 20; i++) {
            const secret = generateTokenSecret();
            expect(secret).toMatch(/^gcw_[0-9a-f]{32}$/);
            expect(isValidTokenFormat(secret)).toBe(true);
        }
    });

    it('generates unique secrets', () => {
        const secrets = new Set(Array.from({ length: 50 }, () => generateTokenSecret()));
        expect(secrets.size).toBe(50);
    });

    it('hashes deterministically to a known SHA-256 vector', () => {
        expect(hashToken(KNOWN_SECRET)).toBe(KNOWN_SECRET_SHA256);
        expect(hashToken(KNOWN_SECRET)).toBe(hashToken(KNOWN_SECRET));
    });

    it('roundtrips: a generated secret always matches its own hash and nothing else', () => {
        const a = generateTokenSecret();
        const b = generateTokenSecret();
        expect(hashToken(a)).not.toBe(hashToken(b));
        expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects malformed token strings', () => {
        expect(isValidTokenFormat('')).toBe(false);
        expect(isValidTokenFormat('gcw_')).toBe(false);
        expect(isValidTokenFormat('gcw_XYZ')).toBe(false);
        expect(isValidTokenFormat('gcw_' + 'a'.repeat(31))).toBe(false);
        expect(isValidTokenFormat('gcw_' + 'a'.repeat(33))).toBe(false);
        expect(isValidTokenFormat('GCW_' + 'a'.repeat(32))).toBe(false);
        expect(isValidTokenFormat('abc_' + 'a'.repeat(32))).toBe(false);
    });
});

describe('parseBearerToken', () => {
    it('extracts gcw_ tokens from Bearer headers', () => {
        expect(parseBearerToken(`Bearer ${KNOWN_SECRET}`)).toBe(KNOWN_SECRET);
        expect(parseBearerToken(`bearer ${KNOWN_SECRET}`)).toBe(KNOWN_SECRET);
        expect(parseBearerToken(`  Bearer   ${KNOWN_SECRET}  `)).toBe(KNOWN_SECRET);
    });

    it('returns null for missing / foreign / non-bearer headers', () => {
        expect(parseBearerToken(null)).toBeNull();
        expect(parseBearerToken(undefined)).toBeNull();
        expect(parseBearerToken('')).toBeNull();
        expect(parseBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
        expect(parseBearerToken('Bearer someOtherToken')).toBeNull();
        expect(parseBearerToken(KNOWN_SECRET)).toBeNull(); // no scheme
    });

    it('TOKEN_PREFIX is gcw_', () => {
        expect(TOKEN_PREFIX).toBe('gcw_');
    });
});

describe('constantTimeEqualHex', () => {
    it('compares correctly', () => {
        expect(constantTimeEqualHex('abc123', 'abc123')).toBe(true);
        expect(constantTimeEqualHex('abc123', 'abc124')).toBe(false);
        expect(constantTimeEqualHex('abc', 'abcd')).toBe(false);
        expect(constantTimeEqualHex('', '')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Role capping
// ---------------------------------------------------------------------------

describe('capRole', () => {
    it('caps at the token role when the user has more access', () => {
        expect(capRole('readonly', 'admin')).toBe('readonly');
        expect(capRole('readonly', 'edit')).toBe('readonly');
        expect(capRole('edit', 'admin')).toBe('edit');
    });

    it('caps at the user role when the user has less access', () => {
        expect(capRole('edit', 'readonly')).toBe('readonly');
    });

    it('returns the shared role when equal', () => {
        expect(capRole('readonly', 'readonly')).toBe('readonly');
        expect(capRole('edit', 'edit')).toBe('edit');
    });

    it('grants nothing when the user has no book access', () => {
        expect(capRole('edit', null)).toBeNull();
        expect(capRole('readonly', null)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// resolveToken
// ---------------------------------------------------------------------------

describe('resolveToken', () => {
    it('returns null for malformed tokens without touching the database', async () => {
        expect(await resolveToken('not-a-token')).toBeNull();
        expect(await resolveToken('gcw_short')).toBeNull();
        expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns null for unknown tokens', async () => {
        db.$queryRaw.mockResolvedValueOnce([]);
        expect(await resolveToken(KNOWN_SECRET)).toBeNull();
    });

    it('returns null for revoked tokens', async () => {
        db.$queryRaw.mockResolvedValueOnce([tokenRow({ revoked_at: new Date() })]);
        expect(await resolveToken(KNOWN_SECRET)).toBeNull();
    });

    it('returns null for expired tokens', async () => {
        db.$queryRaw.mockResolvedValueOnce([
            tokenRow({ expires_at: new Date(Date.now() - 1000) }),
        ]);
        expect(await resolveToken(KNOWN_SECRET)).toBeNull();
    });

    it('accepts tokens with a future expiry', async () => {
        db.$queryRaw.mockResolvedValueOnce([
            tokenRow({ expires_at: new Date(Date.now() + 86400_000) }),
        ]);
        const resolved = await resolveToken(KNOWN_SECRET);
        expect(resolved).toEqual({
            tokenId: 1,
            userId: 7,
            role: 'edit',
            bookGuid: 'book1234book1234book1234book1234',
        });
    });

    it('resolves a valid token and fires a throttled last_used_at update', async () => {
        db.$queryRaw.mockResolvedValueOnce([tokenRow()]);
        const resolved = await resolveToken(KNOWN_SECRET);
        expect(resolved).not.toBeNull();
        expect(resolved!.userId).toBe(7);
        expect(db.$executeRaw).toHaveBeenCalled(); // best-effort usage stamp
    });

    it('rejects a row whose stored hash does not match (constant-time re-check)', async () => {
        db.$queryRaw.mockResolvedValueOnce([tokenRow({ token_hash: 'f'.repeat(64) })]);
        expect(await resolveToken(KNOWN_SECRET)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// authenticateBearer (role capping end-to-end)
// ---------------------------------------------------------------------------

describe('authenticateBearer', () => {
    it('caps an edit token at the user\'s readonly book role', async () => {
        db.$queryRaw.mockResolvedValueOnce([tokenRow({ role: 'edit' })]);
        db.gnucash_web_users.findUnique.mockResolvedValueOnce({ id: 7, username: 'justin' });
        getUserRoleForBookMock.mockResolvedValueOnce('readonly');

        const result = await authenticateBearer(KNOWN_SECRET);
        expect(result).toEqual({
            user: { id: 7, username: 'justin' },
            role: 'readonly',
            bookGuid: 'book1234book1234book1234book1234',
        });
    });

    it('never yields admin even when the user is a book admin', async () => {
        db.$queryRaw.mockResolvedValueOnce([tokenRow({ role: 'edit' })]);
        db.gnucash_web_users.findUnique.mockResolvedValueOnce({ id: 7, username: 'justin' });
        getUserRoleForBookMock.mockResolvedValueOnce('admin');

        const result = await authenticateBearer(KNOWN_SECRET);
        expect(result!.role).toBe('edit');
    });

    it('returns null when the user has no access to the token\'s book', async () => {
        db.$queryRaw.mockResolvedValueOnce([tokenRow()]);
        db.gnucash_web_users.findUnique.mockResolvedValueOnce({ id: 7, username: 'justin' });
        getUserRoleForBookMock.mockResolvedValueOnce(null);

        expect(await authenticateBearer(KNOWN_SECRET)).toBeNull();
    });

    it('falls back to the user\'s first permitted book when the token is unscoped', async () => {
        db.$queryRaw.mockResolvedValueOnce([tokenRow({ book_guid: null })]);
        db.gnucash_web_users.findUnique.mockResolvedValueOnce({ id: 7, username: 'justin' });
        db.gnucash_web_book_permissions.findFirst.mockResolvedValueOnce({ book_guid: 'defaultbook000000000000000000000' });
        getUserRoleForBookMock.mockResolvedValueOnce('edit');

        const result = await authenticateBearer(KNOWN_SECRET);
        expect(result!.bookGuid).toBe('defaultbook000000000000000000000');
    });

    it('returns null for an unknown token', async () => {
        db.$queryRaw.mockResolvedValueOnce([]);
        expect(await authenticateBearer(KNOWN_SECRET)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Webhook event matching & events serialization
// ---------------------------------------------------------------------------

describe('eventMatches', () => {
    it("matches everything for 'all'", () => {
        expect(eventMatches('all', 'budget_alert')).toBe(true);
        expect(eventMatches('all', 'anything')).toBe(true);
    });

    it('matches only listed types for arrays', () => {
        expect(eventMatches(['budget_alert', 'monthly_digest'], 'budget_alert')).toBe(true);
        expect(eventMatches(['budget_alert'], 'spending_anomaly')).toBe(false);
        expect(eventMatches([], 'budget_alert')).toBe(false);
    });
});

describe('parseEvents / serializeEvents', () => {
    it('roundtrips arrays and all', () => {
        expect(parseEvents(serializeEvents('all'))).toBe('all');
        expect(parseEvents(serializeEvents(['a', 'b']))).toEqual(['a', 'b']);
    });

    it("treats null/garbage as 'all'", () => {
        expect(parseEvents(null)).toBe('all');
        expect(parseEvents('not json')).toBe('all');
        expect(parseEvents('{"x":1}')).toBe('all');
    });

    it('filters non-string entries', () => {
        expect(parseEvents('["a", 3, null, "b"]')).toEqual(['a', 'b']);
    });
});

// ---------------------------------------------------------------------------
// HMAC signature
// ---------------------------------------------------------------------------

describe('signPayload', () => {
    it('matches a known HMAC-SHA256 vector', () => {
        expect(signPayload(HMAC_KEY, HMAC_BODY)).toBe(HMAC_EXPECTED);
    });

    it('changes when body or key change', () => {
        expect(signPayload(HMAC_KEY, HMAC_BODY + ' ')).not.toBe(HMAC_EXPECTED);
        expect(signPayload(HMAC_KEY + 'x', HMAC_BODY)).not.toBe(HMAC_EXPECTED);
    });
});

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

describe('validateWebhookUrl', () => {
    it('accepts public http/https URLs', () => {
        expect(validateWebhookUrl('https://example.com/hook').ok).toBe(true);
        expect(validateWebhookUrl('http://example.com:8080/hook?a=1').ok).toBe(true);
    });

    it('rejects non-http protocols', () => {
        expect(validateWebhookUrl('ftp://example.com/x').ok).toBe(false);
        expect(validateWebhookUrl('file:///etc/passwd').ok).toBe(false);
        expect(validateWebhookUrl('javascript:alert(1)').ok).toBe(false);
    });

    it('rejects garbage', () => {
        expect(validateWebhookUrl('not a url').ok).toBe(false);
        expect(validateWebhookUrl('').ok).toBe(false);
    });

    it('rejects localhost, private, and link-local hosts by default', () => {
        for (const url of [
            'http://localhost/hook',
            'http://LOCALHOST:3000/hook',
            'http://127.0.0.1/hook',
            'http://10.1.2.3/hook',
            'http://192.168.4.132/hook',
            'http://172.16.0.1/hook',
            'http://172.31.255.255/hook',
            'http://169.254.169.254/latest/meta-data',
            'http://[::1]/hook',
            'http://myserver.local/hook',
        ]) {
            expect(validateWebhookUrl(url).ok, url).toBe(false);
        }
    });

    it('does not treat 172.32.x.x or 1.2.3.4 as private', () => {
        expect(validateWebhookUrl('http://172.32.0.1/hook').ok).toBe(true);
        expect(validateWebhookUrl('http://1.2.3.4/hook').ok).toBe(true);
    });

    it('allows internal hosts with allowInternal', () => {
        expect(validateWebhookUrl('http://localhost:3000/hook', { allowInternal: true }).ok).toBe(true);
        expect(validateWebhookUrl('http://192.168.4.132/hook', { allowInternal: true }).ok).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

const NOTIFICATION = {
    id: 42,
    userId: 7,
    bookGuid: 'book1234book1234book1234book1234',
    type: 'budget_alert',
    severity: 'warning',
    title: 'Budget overspend: Dining',
    message: 'Dining is 120% of budget.',
    href: '/budgets/abc',
    createdAt: new Date('2026-07-12T00:00:00Z'),
};

function webhookRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 5,
        user_id: 7,
        book_guid: 'book1234book1234book1234book1234',
        url: 'https://example.com/hook',
        secret: HMAC_KEY,
        events: 'all',
        enabled: true,
        created_at: new Date('2026-01-01T00:00:00Z'),
        last_status: null,
        last_delivered_at: null,
        ...overrides,
    };
}

describe('buildWebhookBody', () => {
    it('serializes the documented payload shape with ISO createdAt', () => {
        const body = JSON.parse(buildWebhookBody(NOTIFICATION));
        expect(body).toEqual({
            id: 42,
            type: 'budget_alert',
            severity: 'warning',
            title: 'Budget overspend: Dining',
            message: 'Dining is 120% of budget.',
            href: '/budgets/abc',
            bookGuid: 'book1234book1234book1234book1234',
            createdAt: '2026-07-12T00:00:00.000Z',
        });
    });
});

describe('deliverToWebhook', () => {
    it('POSTs a correctly signed body with event header and records the status', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        const status = await deliverToWebhook(
            { id: 5, url: 'https://example.com/hook', secret: HMAC_KEY },
            NOTIFICATION
        );

        expect(status).toBe('200');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://example.com/hook');
        expect(init.method).toBe('POST');
        expect(init.headers['X-GnucashWeb-Event']).toBe('budget_alert');
        expect(init.headers['X-GnucashWeb-Signature']).toBe(signPayload(HMAC_KEY, init.body));
        expect(init.headers['Content-Type']).toBe('application/json');
        // last_status bookkeeping
        expect(db.$executeRaw).toHaveBeenCalled();
    });

    it('retries once on network failure and succeeds', async () => {
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockResolvedValueOnce({ status: 204 });
        vi.stubGlobal('fetch', fetchMock);

        const status = await deliverToWebhook(
            { id: 5, url: 'https://example.com/hook', secret: HMAC_KEY },
            NOTIFICATION
        );
        expect(status).toBe('204');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries once on HTTP 5xx', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({ status: 500 })
            .mockResolvedValueOnce({ status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        const status = await deliverToWebhook(
            { id: 5, url: 'https://example.com/hook', secret: HMAC_KEY },
            NOTIFICATION
        );
        expect(status).toBe('200');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('records an error status when both attempts fail, without throwing', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
        vi.stubGlobal('fetch', fetchMock);

        const status = await deliverToWebhook(
            { id: 5, url: 'https://example.com/hook', secret: HMAC_KEY },
            NOTIFICATION
        );
        expect(status).toMatch(/^error: /);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('deliverWebhooks', () => {
    it('delivers only to webhooks whose event filter and book match', async () => {
        db.$queryRaw.mockResolvedValueOnce([
            webhookRow({ id: 1, events: 'all' }),
            webhookRow({ id: 2, events: '["budget_alert"]' }),
            webhookRow({ id: 3, events: '["monthly_digest"]', url: 'https://skip.example.com' }),
            webhookRow({ id: 4, book_guid: 'otherbook0000000000000000000000x', url: 'https://otherbook.example.com' }),
            webhookRow({ id: 5, book_guid: null }), // all-books webhook
        ]);
        const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        await deliverWebhooks(NOTIFICATION);

        const urls = fetchMock.mock.calls.map(c => c[0]);
        expect(fetchMock).toHaveBeenCalledTimes(3); // ids 1, 2, 5
        expect(urls).not.toContain('https://skip.example.com');
        expect(urls).not.toContain('https://otherbook.example.com');
    });

    it('matches every book-scoped webhook when the notification has no book', async () => {
        db.$queryRaw.mockResolvedValueOnce([
            webhookRow({ id: 1 }),
            webhookRow({ id: 2, book_guid: null }),
        ]);
        const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        await deliverWebhooks({ ...NOTIFICATION, bookGuid: null });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('never throws, even when the query fails', async () => {
        db.$queryRaw.mockRejectedValueOnce(new Error('db down'));
        await expect(deliverWebhooks(NOTIFICATION)).resolves.toBeUndefined();
    });
});
