import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { db } = vi.hoisted(() => ({
    db: {
        $queryRaw: vi.fn(),
        $executeRaw: vi.fn(),
        $executeRawUnsafe: vi.fn(),
        books: { findUnique: vi.fn() },
        accounts: { findUnique: vi.fn(), findFirst: vi.fn() },
    },
}));

vi.mock('@/lib/prisma', () => ({ default: db }));

import {
    generateShareSecret,
    hashShareToken,
    isValidShareTokenFormat,
    constantTimeEqualHex,
    parseShareSections,
    normalizeExpiryDays,
    createShareLink,
    resolveShareToken,
    SHARE_SECTIONS,
    SHARE_TOKEN_PREFIX,
} from '../share-links';

// Known vector (precomputed with node:crypto)
const KNOWN_SECRET = 'share_0123456789abcdef0123456789abcdef';

function linkRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        user_id: 7,
        book_guid: 'book1234book1234book1234book1234',
        token_hash: hashShareToken(KNOWN_SECRET),
        prefix: 'share_0123',
        label: 'Tax prep',
        reports: ['balance_sheet', 'net_worth'],
        expires_at: new Date(Date.now() + 30 * 86400_000),
        revoked_at: null,
        created_at: new Date('2026-07-01T00:00:00Z'),
        view_count: 0,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    db.$executeRawUnsafe.mockResolvedValue(0);
    db.$executeRaw.mockResolvedValue(1);
});

afterEach(() => {
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Token roundtrip
// ---------------------------------------------------------------------------

describe('share token format and hashing', () => {
    it('generates share_ + 32 lowercase hex chars', () => {
        for (let i = 0; i < 20; i++) {
            const secret = generateShareSecret();
            expect(secret).toMatch(/^share_[0-9a-f]{32}$/);
            expect(secret.startsWith(SHARE_TOKEN_PREFIX)).toBe(true);
            expect(isValidShareTokenFormat(secret)).toBe(true);
        }
    });

    it('generates unique secrets', () => {
        const secrets = new Set(Array.from({ length: 50 }, () => generateShareSecret()));
        expect(secrets.size).toBe(50);
    });

    it('hashes deterministically and distinctly', () => {
        expect(hashShareToken(KNOWN_SECRET)).toBe(hashShareToken(KNOWN_SECRET));
        expect(hashShareToken(KNOWN_SECRET)).toMatch(/^[0-9a-f]{64}$/);
        expect(hashShareToken(generateShareSecret())).not.toBe(hashShareToken(generateShareSecret()));
    });

    it('rejects malformed token strings', () => {
        expect(isValidShareTokenFormat('')).toBe(false);
        expect(isValidShareTokenFormat('share_')).toBe(false);
        expect(isValidShareTokenFormat('share_XYZ')).toBe(false);
        expect(isValidShareTokenFormat('share_' + 'a'.repeat(31))).toBe(false);
        expect(isValidShareTokenFormat('share_' + 'a'.repeat(33))).toBe(false);
        expect(isValidShareTokenFormat('SHARE_' + 'a'.repeat(32))).toBe(false);
        expect(isValidShareTokenFormat('gcw_' + 'a'.repeat(32))).toBe(false);
    });

    it('constant-time compare matches equal digests and rejects others', () => {
        const h = hashShareToken(KNOWN_SECRET);
        expect(constantTimeEqualHex(h, h)).toBe(true);
        expect(constantTimeEqualHex(h, hashShareToken('share_' + 'f'.repeat(32)))).toBe(false);
        expect(constantTimeEqualHex(h, h.slice(0, 32))).toBe(false);
    });

    it('roundtrips: create() stores the hash + prefix and returns the secret once', async () => {
        let insertedHash: string | null = null;
        let insertedPrefix: string | null = null;
        db.$queryRaw.mockImplementation((_strings: TemplateStringsArray, ...values: unknown[]) => {
            // INSERT values: userId, bookGuid, tokenHash, prefix, label, reports, expiresAt
            insertedHash = values[2] as string;
            insertedPrefix = values[3] as string;
            return Promise.resolve([linkRow({ token_hash: insertedHash, prefix: insertedPrefix })]);
        });

        const { link, secret } = await createShareLink(7, {
            bookGuid: 'book1234book1234book1234book1234',
            label: 'Tax prep',
            expiresAt: new Date(Date.now() + 7 * 86400_000),
            sections: ['balance_sheet'],
        });

        expect(isValidShareTokenFormat(secret)).toBe(true);
        expect(insertedHash).toBe(hashShareToken(secret));
        expect(insertedPrefix).toBe(secret.slice(0, 10));
        expect(link.prefix).toBe(secret.slice(0, 10));
        // The record never carries the secret or hash.
        expect(JSON.stringify(link)).not.toContain(secret);
    });

    it('create() rejects empty labels and past expiry', async () => {
        await expect(createShareLink(7, {
            bookGuid: 'b', label: '   ', expiresAt: new Date(Date.now() + 1000),
        })).rejects.toThrow(/label/i);
        await expect(createShareLink(7, {
            bookGuid: 'b', label: 'x', expiresAt: new Date(Date.now() - 1000),
        })).rejects.toThrow(/future/i);
    });
});

// ---------------------------------------------------------------------------
// Resolve: expiry + revocation
// ---------------------------------------------------------------------------

describe('resolveShareToken', () => {
    it('resolves a valid, unexpired, unrevoked token', async () => {
        db.$queryRaw.mockResolvedValue([linkRow()]);
        const resolved = await resolveShareToken(KNOWN_SECRET);
        expect(resolved).not.toBeNull();
        expect(resolved!.bookGuid).toBe('book1234book1234book1234book1234');
        expect(resolved!.label).toBe('Tax prep');
        expect(resolved!.sections).toEqual(['balance_sheet', 'net_worth']);
    });

    it('returns null without querying for malformed tokens', async () => {
        expect(await resolveShareToken('nonsense')).toBeNull();
        expect(await resolveShareToken('share_zzz')).toBeNull();
        expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns null for unknown tokens', async () => {
        db.$queryRaw.mockResolvedValue([]);
        expect(await resolveShareToken(KNOWN_SECRET)).toBeNull();
    });

    it('returns null for revoked tokens', async () => {
        db.$queryRaw.mockResolvedValue([linkRow({ revoked_at: new Date() })]);
        expect(await resolveShareToken(KNOWN_SECRET)).toBeNull();
    });

    it('returns null for expired tokens', async () => {
        db.$queryRaw.mockResolvedValue([linkRow({ expires_at: new Date(Date.now() - 1000) })]);
        expect(await resolveShareToken(KNOWN_SECRET)).toBeNull();
    });

    it('expiry boundary: a token expiring right now is already invalid', async () => {
        db.$queryRaw.mockResolvedValue([linkRow({ expires_at: new Date(Date.now()) })]);
        expect(await resolveShareToken(KNOWN_SECRET)).toBeNull();
    });

    it('rejects a row whose stored hash does not match (constant-time recheck)', async () => {
        db.$queryRaw.mockResolvedValue([linkRow({ token_hash: 'f'.repeat(64) })]);
        expect(await resolveShareToken(KNOWN_SECRET)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Section selection validation
// ---------------------------------------------------------------------------

describe('parseShareSections', () => {
    const ALL = SHARE_SECTIONS.map(s => s.key);

    it('keeps valid sections in canonical order and dedupes', () => {
        expect(parseShareSections(['net_worth', 'balance_sheet', 'net_worth']))
            .toEqual(['balance_sheet', 'net_worth']);
    });

    it('drops unknown and non-string entries', () => {
        expect(parseShareSections(['balance_sheet', 'evil_section', 42, null]))
            .toEqual(['balance_sheet']);
    });

    it('falls back to ALL sections for empty or invalid input', () => {
        expect(parseShareSections([])).toEqual(ALL);
        expect(parseShareSections(null)).toEqual(ALL);
        expect(parseShareSections('balance_sheet')).toEqual(ALL);
        expect(parseShareSections(['nope'])).toEqual(ALL);
        expect(parseShareSections({ balance_sheet: true })).toEqual(ALL);
    });

    it('accepts the full set', () => {
        expect(parseShareSections(ALL)).toEqual(ALL);
    });
});

describe('normalizeExpiryDays', () => {
    it('accepts only 7/30/90 and defaults to 30', () => {
        expect(normalizeExpiryDays(7)).toBe(7);
        expect(normalizeExpiryDays(30)).toBe(30);
        expect(normalizeExpiryDays(90)).toBe(90);
        expect(normalizeExpiryDays(365)).toBe(30);
        expect(normalizeExpiryDays('nope')).toBe(30);
        expect(normalizeExpiryDays(undefined)).toBe(30);
    });
});
