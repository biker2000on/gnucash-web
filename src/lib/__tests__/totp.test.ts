/**
 * Tests for the pure TOTP core (src/lib/totp.ts).
 *
 * The RFC 6238 test vectors (Appendix B) use the ASCII secret
 * "12345678901234567890" with HMAC-SHA1. The published vectors are
 * 8-digit codes; the 6-digit equivalents are their last six digits
 * (dynamic truncation is identical, only the final modulus differs).
 */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
    base32Encode,
    base32Decode,
    generateSecret,
    totp,
    verifyTotp,
    otpauthUri,
    constantTimeEqual,
    generateRecoveryCodes,
    hashRecoveryCode,
    normalizeRecoveryCode,
    consumeRecoveryCode,
    looksLikeRecoveryCode,
} from '../totp';

const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_B32 = base32Encode(Buffer.from(RFC_SECRET_ASCII, 'ascii'));

describe('base32 (RFC 4648)', () => {
    const vectors: Array<[string, string]> = [
        ['', ''],
        ['f', 'MY'],
        ['fo', 'MZXQ'],
        ['foo', 'MZXW6'],
        ['foob', 'MZXW6YQ'],
        ['fooba', 'MZXW6YTB'],
        ['foobar', 'MZXW6YTBOI'],
    ];

    it('encodes the RFC 4648 test vectors (unpadded)', () => {
        for (const [input, expected] of vectors) {
            expect(base32Encode(Buffer.from(input, 'ascii'))).toBe(expected);
        }
    });

    it('decodes the RFC 4648 test vectors', () => {
        for (const [input, encoded] of vectors) {
            expect(base32Decode(encoded).toString('ascii')).toBe(input);
        }
    });

    it('encodes the RFC 6238 secret to the well-known base32 form', () => {
        expect(RFC_SECRET_B32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    });

    it('round-trips random buffers of every length 0..64', () => {
        for (let len = 0; len <= 64; len++) {
            const buf = crypto.randomBytes(len);
            expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
        }
    });

    it('tolerates lowercase, padding, and whitespace on decode', () => {
        expect(base32Decode('mzxw6ytboi======').toString('ascii')).toBe('foobar');
        expect(base32Decode('MZXW 6YTB OI').toString('ascii')).toBe('foobar');
    });

    it('rejects invalid characters', () => {
        expect(() => base32Decode('MZXW!YTB')).toThrow(/Invalid base32/);
        expect(() => base32Decode('ABC1')).toThrow(/Invalid base32/); // '1' not in alphabet
    });
});

describe('generateSecret', () => {
    it('produces a 32-char base32 string decoding to 20 bytes', () => {
        const secret = generateSecret();
        expect(secret).toMatch(/^[A-Z2-7]{32}$/);
        expect(base32Decode(secret).length).toBe(20);
    });

    it('produces distinct secrets', () => {
        const seen = new Set(Array.from({ length: 20 }, () => generateSecret()));
        expect(seen.size).toBe(20);
    });
});

describe('totp — RFC 6238 test vectors (HMAC-SHA1)', () => {
    // [unix time (s), 8-digit code]
    const vectors: Array<[number, string]> = [
        [59, '94287082'],
        [1111111109, '07081804'],
        [1111111111, '14050471'],
        [1234567890, '89005924'],
        [2000000000, '69279037'],
        [20000000000, '65353130'],
    ];

    it('matches the official 8-digit vectors', () => {
        for (const [time, code] of vectors) {
            expect(totp(RFC_SECRET_B32, time, { digits: 8 })).toBe(code);
        }
    });

    it('matches the vectors truncated to 6 digits (default)', () => {
        for (const [time, code] of vectors) {
            expect(totp(RFC_SECRET_B32, time)).toBe(code.slice(-6));
        }
    });

    it('uses a 30-second step by default (T=59 and T=30 share a counter)', () => {
        expect(totp(RFC_SECRET_B32, 59)).toBe(totp(RFC_SECRET_B32, 30));
        expect(totp(RFC_SECRET_B32, 59)).not.toBe(totp(RFC_SECRET_B32, 60));
    });

    it('respects a custom step', () => {
        expect(totp(RFC_SECRET_B32, 119, { step: 60 })).toBe(totp(RFC_SECRET_B32, 60, { step: 60 }));
    });
});

describe('verifyTotp — window handling', () => {
    const T = 1111111111; // mid-vector time

    it('accepts the exact current code', () => {
        expect(verifyTotp(RFC_SECRET_B32, '050471', { time: T })).toBe(true);
    });

    it('accepts codes from one step before and after with window=1 (default)', () => {
        const prev = totp(RFC_SECRET_B32, T - 30);
        const next = totp(RFC_SECRET_B32, T + 30);
        expect(verifyTotp(RFC_SECRET_B32, prev, { time: T })).toBe(true);
        expect(verifyTotp(RFC_SECRET_B32, next, { time: T })).toBe(true);
    });

    it('rejects a one-step-old code with window=0', () => {
        const prev = totp(RFC_SECRET_B32, T - 30);
        expect(verifyTotp(RFC_SECRET_B32, prev, { time: T, window: 0 })).toBe(false);
        expect(verifyTotp(RFC_SECRET_B32, '050471', { time: T, window: 0 })).toBe(true);
    });

    it('rejects codes two steps away with window=1', () => {
        const past = totp(RFC_SECRET_B32, T - 60);
        const future = totp(RFC_SECRET_B32, T + 60);
        expect(verifyTotp(RFC_SECRET_B32, past, { time: T })).toBe(false);
        expect(verifyTotp(RFC_SECRET_B32, future, { time: T })).toBe(false);
    });

    it('tolerates internal whitespace ("050 471")', () => {
        expect(verifyTotp(RFC_SECRET_B32, '050 471', { time: T })).toBe(true);
    });

    it('rejects malformed codes (wrong length, non-digits, empty)', () => {
        expect(verifyTotp(RFC_SECRET_B32, '', { time: T })).toBe(false);
        expect(verifyTotp(RFC_SECRET_B32, '05047', { time: T })).toBe(false);
        expect(verifyTotp(RFC_SECRET_B32, '0504711', { time: T })).toBe(false);
        expect(verifyTotp(RFC_SECRET_B32, '05047a', { time: T })).toBe(false);
    });

    it('rejects an invalid base32 secret instead of throwing', () => {
        expect(verifyTotp('not!base32', '123456', { time: T })).toBe(false);
    });
});

describe('constantTimeEqual', () => {
    it('returns true for equal strings', () => {
        expect(constantTimeEqual('287082', '287082')).toBe(true);
        expect(constantTimeEqual('', '')).toBe(true);
    });

    it('returns false for different strings', () => {
        expect(constantTimeEqual('287082', '287083')).toBe(false);
    });

    it('returns false for different lengths (no length leak via throw)', () => {
        expect(constantTimeEqual('28708', '287082')).toBe(false);
        expect(constantTimeEqual('287082', '')).toBe(false);
    });
});

describe('recovery codes', () => {
    it('generates the requested number of xxxx-xxxx codes (default 10)', () => {
        const codes = generateRecoveryCodes();
        expect(codes).toHaveLength(10);
        for (const code of codes) {
            expect(code).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{4}-[23456789abcdefghjkmnpqrstuvwxyz]{4}$/);
            expect(looksLikeRecoveryCode(code)).toBe(true);
        }
        expect(new Set(codes).size).toBe(10);
    });

    it('normalizes case and separators before hashing', () => {
        const [code] = generateRecoveryCodes(1);
        const noDash = code.replace('-', '');
        expect(normalizeRecoveryCode(code)).toBe(noDash);
        expect(hashRecoveryCode(code)).toBe(hashRecoveryCode(noDash));
        expect(hashRecoveryCode(code)).toBe(hashRecoveryCode(code.toUpperCase()));
        expect(hashRecoveryCode(` ${code} `)).toBe(hashRecoveryCode(code));
    });

    it('stores sha256 hex, never the plaintext', () => {
        const [code] = generateRecoveryCodes(1);
        const hash = hashRecoveryCode(code);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(hash).not.toContain(normalizeRecoveryCode(code));
    });

    it('consumes a code exactly once (single-use)', () => {
        const codes = generateRecoveryCodes(3);
        const hashes = codes.map(hashRecoveryCode);

        const afterFirst = consumeRecoveryCode(hashes, codes[1]);
        expect(afterFirst).not.toBeNull();
        expect(afterFirst).toHaveLength(2);
        expect(afterFirst).not.toContain(hashRecoveryCode(codes[1]));

        // Same code again against the remaining hashes: rejected
        expect(consumeRecoveryCode(afterFirst!, codes[1])).toBeNull();

        // Other codes still work
        expect(consumeRecoveryCode(afterFirst!, codes[0])).toHaveLength(1);
    });

    it('accepts case/format variants when consuming', () => {
        const codes = generateRecoveryCodes(2);
        const hashes = codes.map(hashRecoveryCode);
        expect(consumeRecoveryCode(hashes, codes[0].toUpperCase().replace('-', ''))).toHaveLength(1);
    });

    it('rejects unknown codes', () => {
        const hashes = generateRecoveryCodes(2).map(hashRecoveryCode);
        expect(consumeRecoveryCode(hashes, 'zzzz-zzzz')).toBeNull();
        expect(consumeRecoveryCode([], 'zzzz-zzzz')).toBeNull();
    });
});

describe('otpauthUri', () => {
    it('builds a spec-shaped otpauth URI with the default issuer', () => {
        const uri = otpauthUri('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'justin');
        expect(uri).toBe(
            'otpauth://totp/GnuCash%20Web:justin' +
            '?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' +
            '&issuer=GnuCash%20Web&algorithm=SHA1&digits=6&period=30'
        );
    });

    it('percent-encodes account names and custom issuers', () => {
        const uri = otpauthUri('ABCD2345', 'user name@host', 'My App');
        expect(uri.startsWith('otpauth://totp/My%20App:user%20name%40host?')).toBe(true);
        expect(uri).toContain('issuer=My%20App');
        expect(uri).not.toContain('+'); // spaces must be %20, not '+'
    });
});
