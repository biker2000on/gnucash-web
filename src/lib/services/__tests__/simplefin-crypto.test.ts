/**
 * Audit finding S2 (docs/audit-2026-08-03.md): SimpleFin access URLs used to be
 * sealed with a constant committed to this public repository.
 *
 * New writes now use SESSION_SECRET/NEXTAUTH_SECRET. Existing rows were written
 * under the old constant, so decryption must still open them — otherwise the
 * deploy silently breaks every live bank connection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

import {
    encryptAccessUrl,
    decryptAccessUrl,
    isLegacyEncryptedAccessUrl,
} from '../simplefin.service';

const RETIRED_CONSTANT = 'complex_password_at_least_32_characters_long_12345';
const ACCESS_URL = 'https://user:pass@bridge.simplefin.org/simplefin';

/** Reproduces exactly how rows were written before the fix. */
function sealWithRetiredConstant(url: string): string {
    const salt = randomBytes(16);
    const key = scryptSync(RETIRED_CONSTANT, salt, 32);
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(url, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return [
        salt.toString('hex'),
        iv.toString('hex'),
        cipher.getAuthTag().toString('hex'),
        encrypted,
    ].join(':');
}

const ORIGINAL_SESSION = process.env.SESSION_SECRET;
const ORIGINAL_NEXTAUTH = process.env.NEXTAUTH_SECRET;

beforeEach(() => {
    process.env.SESSION_SECRET = 'a-real-deployment-secret-at-least-32-chars-long';
    delete process.env.NEXTAUTH_SECRET;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    process.env.SESSION_SECRET = ORIGINAL_SESSION;
    if (ORIGINAL_NEXTAUTH === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = ORIGINAL_NEXTAUTH;
    vi.restoreAllMocks();
});

describe('SimpleFin access URL encryption', () => {
    it('round-trips under the real secret', () => {
        expect(decryptAccessUrl(encryptAccessUrl(ACCESS_URL))).toBe(ACCESS_URL);
    });

    it('still opens credentials sealed with the retired constant', () => {
        const legacy = sealWithRetiredConstant(ACCESS_URL);
        expect(decryptAccessUrl(legacy)).toBe(ACCESS_URL);
    });

    it('flags a legacy credential so it can be surfaced for rotation', () => {
        expect(isLegacyEncryptedAccessUrl(sealWithRetiredConstant(ACCESS_URL))).toBe(true);
        expect(isLegacyEncryptedAccessUrl(encryptAccessUrl(ACCESS_URL))).toBe(false);
    });

    it('never seals new credentials with the retired constant', () => {
        const sealed = encryptAccessUrl(ACCESS_URL);
        const [saltHex, ivHex, tagHex, data] = sealed.split(':');
        const key = scryptSync(RETIRED_CONSTANT, Buffer.from(saltHex, 'hex'), 32);
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        expect(() => {
            decipher.update(data, 'hex', 'utf8');
            decipher.final('utf8');
        }).toThrow();
    });

    it('falls back to NEXTAUTH_SECRET when SESSION_SECRET is unset', () => {
        delete process.env.SESSION_SECRET;
        process.env.NEXTAUTH_SECRET = 'nextauth-secret-that-is-at-least-32-characters';
        expect(decryptAccessUrl(encryptAccessUrl(ACCESS_URL))).toBe(ACCESS_URL);
    });

    it('refuses to encrypt when no secret is configured', () => {
        delete process.env.SESSION_SECRET;
        delete process.env.NEXTAUTH_SECRET;
        expect(() => encryptAccessUrl(ACCESS_URL)).toThrow(/SESSION_SECRET/);
    });
});
