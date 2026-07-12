/**
 * TOTP enrollment store.
 *
 * Persists per-user TOTP enrollment in a lazily-created table
 * (gnucash_web_totp) using the same advisory-lock pattern as the other
 * gnucash_web_* side tables. The shared secret is encrypted at rest using
 * the exact same mechanism/key derivation as ai-config's API key
 * (aes-256-cbc, key = sha256(SESSION_SECRET || NEXTAUTH_SECRET)).
 *
 * 2FA is strictly OPT-IN: users without a row here (or without enabled_at
 * set) are completely unaffected by any of this.
 */

import crypto from 'crypto';
import { query } from './db';
import {
    generateSecret,
    verifyTotp,
    generateRecoveryCodes,
    hashRecoveryCode,
    consumeRecoveryCode,
    looksLikeRecoveryCode,
} from './totp';

// ---------------------------------------------------------------------------
// Encryption at rest — identical mechanism to src/lib/ai-config.ts
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-cbc';

function getEncryptionKey(): Buffer {
    const secret = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET || '';
    return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text: string): string | null {
    try {
        const [ivHex, encHex] = text.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const encrypted = Buffer.from(encHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch {
        return null; // Key changed or corrupted — user needs to re-enroll
    }
}

// ---------------------------------------------------------------------------
// Lazy table creation (advisory-lock pattern)
// ---------------------------------------------------------------------------

let ensurePromise: Promise<void> | null = null;

function ensureTotpTable(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await query(`
                DO $$
                BEGIN
                  PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_totp_schema'));

                  CREATE TABLE IF NOT EXISTS gnucash_web_totp (
                    user_id INTEGER PRIMARY KEY,
                    secret_encrypted TEXT NOT NULL,
                    enabled_at TIMESTAMP NULL,
                    recovery_code_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                  );
                END $$;
            `);
        })().catch(err => {
            // Allow retry on next call rather than caching the failure forever
            ensurePromise = null;
            throw err;
        });
    }
    return ensurePromise;
}

// ---------------------------------------------------------------------------
// Row access
// ---------------------------------------------------------------------------

interface TotpRow {
    user_id: number;
    secret_encrypted: string;
    enabled_at: Date | null;
    recovery_code_hashes: string[];
}

async function getRow(userId: number): Promise<TotpRow | null> {
    await ensureTotpTable();
    const result = await query(
        'SELECT user_id, secret_encrypted, enabled_at, recovery_code_hashes FROM gnucash_web_totp WHERE user_id = $1',
        [userId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
        user_id: row.user_id,
        secret_encrypted: row.secret_encrypted,
        enabled_at: row.enabled_at,
        recovery_code_hashes: Array.isArray(row.recovery_code_hashes)
            ? row.recovery_code_hashes
            : [],
    };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TotpStatus {
    /** True when the user has confirmed enrollment — login requires a code. */
    enabled: boolean;
    /** True when a secret was issued but not yet confirmed. */
    pending: boolean;
    enabledAt: string | null;
    /** Number of unused recovery codes (only meaningful when enabled). */
    recoveryCodesRemaining: number;
}

/** Enrollment status for a user. Users who never opted in get all-false. */
export async function getTotpStatus(userId: number): Promise<TotpStatus> {
    const row = await getRow(userId);
    if (!row) {
        return { enabled: false, pending: false, enabledAt: null, recoveryCodesRemaining: 0 };
    }
    const enabled = row.enabled_at !== null;
    return {
        enabled,
        pending: !enabled,
        enabledAt: row.enabled_at ? row.enabled_at.toISOString() : null,
        recoveryCodesRemaining: enabled ? row.recovery_code_hashes.length : 0,
    };
}

/** Fast check used by the login flow: is TOTP fully enabled for this user? */
export async function isTotpEnabled(userId: number): Promise<boolean> {
    const row = await getRow(userId);
    return row !== null && row.enabled_at !== null;
}

/**
 * Begin (or restart) enrollment: create/replace a pending secret.
 * Fails if TOTP is already enabled — the user must disable it first.
 * Returns the new plaintext secret (base32) for display/QR provisioning.
 */
export async function beginEnrollment(userId: number): Promise<{ secret: string }> {
    const row = await getRow(userId);
    if (row && row.enabled_at !== null) {
        throw new Error('Two-factor authentication is already enabled. Disable it first to re-enroll.');
    }

    const secret = generateSecret();
    await query(
        `INSERT INTO gnucash_web_totp (user_id, secret_encrypted, enabled_at, recovery_code_hashes, updated_at)
         VALUES ($1, $2, NULL, '[]'::jsonb, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           secret_encrypted = EXCLUDED.secret_encrypted,
           enabled_at = NULL,
           recovery_code_hashes = '[]'::jsonb,
           updated_at = NOW()`,
        [userId, encrypt(secret)]
    );
    return { secret };
}

/**
 * Confirm enrollment with a live code from the authenticator app.
 * On success, TOTP becomes enabled and the recovery codes are generated
 * and returned in plaintext — this is the ONLY time they are visible.
 * Returns null if the code is wrong (enrollment stays pending).
 */
export async function confirmEnrollment(
    userId: number,
    code: string
): Promise<{ recoveryCodes: string[] } | null> {
    const row = await getRow(userId);
    if (!row) {
        throw new Error('No enrollment in progress. Start enrollment first.');
    }
    if (row.enabled_at !== null) {
        throw new Error('Two-factor authentication is already enabled.');
    }

    const secret = decrypt(row.secret_encrypted);
    if (!secret) {
        throw new Error('Enrollment data is unreadable (server key changed). Start enrollment again.');
    }

    if (!verifyTotp(secret, code, { window: 1 })) {
        return null;
    }

    const recoveryCodes = generateRecoveryCodes(10);
    const hashes = recoveryCodes.map(hashRecoveryCode);
    await query(
        `UPDATE gnucash_web_totp
         SET enabled_at = NOW(), recovery_code_hashes = $2::jsonb, updated_at = NOW()
         WHERE user_id = $1`,
        [userId, JSON.stringify(hashes)]
    );
    return { recoveryCodes };
}

/**
 * Verify a code for an ENABLED enrollment: either a live TOTP code or an
 * unused recovery code. Recovery codes are single-use — a successful match
 * consumes the code. Returns false for users without TOTP enabled.
 */
export async function verifyLogin(userId: number, code: string): Promise<boolean> {
    const row = await getRow(userId);
    if (!row || row.enabled_at === null) return false;

    const trimmed = code.trim();

    // 6-digit codes are TOTP; recovery codes are 8 alphanumerics (xxxx-xxxx).
    if (/^\d{6}$/.test(trimmed.replace(/\s+/g, ''))) {
        const secret = decrypt(row.secret_encrypted);
        if (!secret) return false;
        return verifyTotp(secret, trimmed, { window: 1 });
    }

    if (looksLikeRecoveryCode(trimmed)) {
        const remaining = consumeRecoveryCode(row.recovery_code_hashes, trimmed);
        if (remaining === null) return false;
        await query(
            `UPDATE gnucash_web_totp
             SET recovery_code_hashes = $2::jsonb, updated_at = NOW()
             WHERE user_id = $1`,
            [userId, JSON.stringify(remaining)]
        );
        return true;
    }

    return false;
}

/**
 * Disable TOTP. Requires a valid current TOTP code or an unused recovery
 * code. Deletes the enrollment row entirely (also clears a pending,
 * never-confirmed enrollment without requiring a code).
 * Returns true on success, false if the code was invalid.
 */
export async function disableTotp(userId: number, code: string): Promise<boolean> {
    const row = await getRow(userId);
    if (!row) return true; // nothing to disable

    if (row.enabled_at === null) {
        // Pending enrollment was never confirmed — safe to discard freely.
        await query('DELETE FROM gnucash_web_totp WHERE user_id = $1', [userId]);
        return true;
    }

    const ok = await verifyLogin(userId, code);
    if (!ok) return false;

    await query('DELETE FROM gnucash_web_totp WHERE user_id = $1', [userId]);
    return true;
}

/**
 * Regenerate recovery codes (invalidates all previous ones). Requires a
 * valid current TOTP code or an unused recovery code. Returns the new
 * plaintext codes, or null if the provided code was invalid.
 */
export async function regenerateRecoveryCodes(
    userId: number,
    code: string
): Promise<{ recoveryCodes: string[] } | null> {
    const row = await getRow(userId);
    if (!row || row.enabled_at === null) {
        throw new Error('Two-factor authentication is not enabled.');
    }

    const ok = await verifyLogin(userId, code);
    if (!ok) return null;

    const recoveryCodes = generateRecoveryCodes(10);
    const hashes = recoveryCodes.map(hashRecoveryCode);
    await query(
        `UPDATE gnucash_web_totp
         SET recovery_code_hashes = $2::jsonb, updated_at = NOW()
         WHERE user_id = $1`,
        [userId, JSON.stringify(hashes)]
    );
    return { recoveryCodes };
}
