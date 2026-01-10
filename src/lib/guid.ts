/**
 * GUID utilities for GnuCash compatibility
 * GnuCash uses 32-character lowercase hex strings without dashes
 */

/**
 * Generate a GnuCash-compatible GUID (32 hex characters, no dashes)
 */
export function generateGuid(): string {
    // Generate 16 random bytes and convert to hex
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Validate a GUID string (32 hex characters)
 */
export function isValidGuid(guid: string): boolean {
    return /^[a-f0-9]{32}$/i.test(guid);
}

/**
 * Normalize a GUID to lowercase
 */
export function normalizeGuid(guid: string): string {
    return guid.toLowerCase();
}
