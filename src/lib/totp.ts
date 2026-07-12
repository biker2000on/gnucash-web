/**
 * TOTP (RFC 6238) core — pure functions, node:crypto only, no external deps.
 *
 * Implements HMAC-SHA1 time-based one-time passwords compatible with
 * Google Authenticator, Aegis, 1Password, etc., plus base32 encoding
 * (RFC 4648) and single-use recovery codes.
 *
 * This module is intentionally free of any I/O — persistence lives in
 * totp-store.ts.
 */

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Base32 (RFC 4648)
// ---------------------------------------------------------------------------

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Encode bytes as unpadded RFC 4648 base32. */
export function base32Encode(data: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of data) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        out += B32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return out;
}

/** Decode RFC 4648 base32 (case-insensitive, padding and whitespace tolerated). */
export function base32Decode(encoded: string): Buffer {
    const clean = encoded.toUpperCase().replace(/[=\s-]/g, '');
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const ch of clean) {
        const idx = B32_ALPHABET.indexOf(ch);
        if (idx === -1) {
            throw new Error(`Invalid base32 character: ${ch}`);
        }
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// Constant-time comparison
// ---------------------------------------------------------------------------

/**
 * Constant-time string equality. Compares SHA-256 digests via
 * crypto.timingSafeEqual so timing does not leak length or prefix.
 */
export function constantTimeEqual(a: string, b: string): boolean {
    const da = crypto.createHash('sha256').update(a, 'utf8').digest();
    const db = crypto.createHash('sha256').update(b, 'utf8').digest();
    return crypto.timingSafeEqual(da, db);
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238, HMAC-SHA1)
// ---------------------------------------------------------------------------

export interface TotpOptions {
    /** Time step in seconds (default 30). */
    step?: number;
    /** Number of code digits (default 6). */
    digits?: number;
}

export interface VerifyTotpOptions extends TotpOptions {
    /** Accept codes within ± this many steps of now (default 1). */
    window?: number;
    /** Unix time in seconds to verify against (default: now). Mainly for tests. */
    time?: number;
}

/** Generate a new random TOTP secret: 20 random bytes as base32 (32 chars). */
export function generateSecret(): string {
    return base32Encode(crypto.randomBytes(20));
}

/** RFC 4226 HOTP with HMAC-SHA1 and dynamic truncation. */
function hotp(key: Buffer, counter: number, digits: number): string {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const mac = crypto.createHmac('sha1', key).update(msg).digest();
    const offset = mac[mac.length - 1] & 0xf;
    const bin =
        ((mac[offset] & 0x7f) << 24) |
        (mac[offset + 1] << 16) |
        (mac[offset + 2] << 8) |
        mac[offset + 3];
    return (bin % 10 ** digits).toString().padStart(digits, '0');
}

/**
 * Compute the TOTP code for a base32 secret.
 *
 * @param secret base32-encoded shared secret
 * @param time   Unix time in SECONDS (default: now)
 */
export function totp(
    secret: string,
    time: number = Math.floor(Date.now() / 1000),
    options: TotpOptions = {}
): string {
    const { step = 30, digits = 6 } = options;
    const key = base32Decode(secret);
    const counter = Math.floor(time / step);
    return hotp(key, counter, digits);
}

/**
 * Verify a TOTP code against a base32 secret, accepting codes within
 * ±window time steps. Uses constant-time comparison and always checks
 * every step in the window (no early exit).
 */
export function verifyTotp(
    secret: string,
    code: string,
    options: VerifyTotpOptions = {}
): boolean {
    const { step = 30, digits = 6, window = 1 } = options;
    const time = options.time ?? Math.floor(Date.now() / 1000);

    const normalized = code.replace(/\s+/g, '');
    if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) {
        return false;
    }

    let key: Buffer;
    try {
        key = base32Decode(secret);
    } catch {
        return false;
    }

    const counter = Math.floor(time / step);
    let valid = false;
    for (let offset = -window; offset <= window; offset++) {
        const candidateCounter = counter + offset;
        if (candidateCounter < 0) continue;
        const candidate = hotp(key, candidateCounter, digits);
        // Bitwise OR (no short-circuit) so every window step is checked.
        valid = constantTimeEqual(candidate, normalized) || valid;
    }
    return valid;
}

// ---------------------------------------------------------------------------
// otpauth:// URI
// ---------------------------------------------------------------------------

/**
 * Build the otpauth:// provisioning URI for authenticator apps
 * (scan as QR or enter manually).
 */
export function otpauthUri(
    secret: string,
    accountName: string,
    issuer: string = 'GnuCash Web'
): string {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
    // Percent-encode manually: URLSearchParams would emit '+' for spaces,
    // which some authenticator apps parse literally.
    const params = [
        `secret=${secret}`,
        `issuer=${encodeURIComponent(issuer)}`,
        'algorithm=SHA1',
        'digits=6',
        'period=30',
    ].join('&');
    return `otpauth://totp/${label}?${params}`;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/** Unambiguous lowercase alphabet (no 0/o/1/l/i). */
const RECOVERY_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/** Format check for a recovery code: xxxx-xxxx (dash optional on input). */
export function looksLikeRecoveryCode(input: string): boolean {
    return /^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(input.trim());
}

/** Normalize a recovery code: lowercase, strip everything non-alphanumeric. */
export function normalizeRecoveryCode(code: string): string {
    return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Generate `count` random recovery codes in xxxx-xxxx format. */
export function generateRecoveryCodes(count: number = 10): string[] {
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
        let raw = '';
        for (let j = 0; j < 8; j++) {
            raw += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
        }
        codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
    }
    return codes;
}

/** SHA-256 hex hash of a normalized recovery code (what is stored at rest). */
export function hashRecoveryCode(code: string): string {
    return crypto
        .createHash('sha256')
        .update(normalizeRecoveryCode(code), 'utf8')
        .digest('hex');
}

/**
 * Attempt to consume a recovery code against a list of stored hashes.
 * Returns the remaining hashes (with the matched one removed) if the code
 * matched, or null if it did not. Pure — persistence is the caller's job.
 */
export function consumeRecoveryCode(
    storedHashes: readonly string[],
    code: string
): string[] | null {
    const target = hashRecoveryCode(code);
    let matchIndex = -1;
    // Check every hash (constant-time compare per entry, no early exit).
    for (let i = 0; i < storedHashes.length; i++) {
        if (constantTimeEqual(storedHashes[i], target)) {
            matchIndex = i;
        }
    }
    if (matchIndex === -1) return null;
    return storedHashes.filter((_, i) => i !== matchIndex);
}
