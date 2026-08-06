// src/lib/simplefin-error-fingerprint.ts

/**
 * Stable fingerprints for SimpleFin sync failures, used as notification
 * `source_id` values.
 *
 * Lives in its own module because both the sync service and
 * `@/lib/notifications` need it, and the service already imports notifications
 * — deriving it from either side would close an import cycle.
 *
 * Dependency-free on purpose: no prisma, no config, nothing that would make
 * this awkward to import from anywhere.
 */

/**
 * Strip the parts of an error string that change between runs without the
 * underlying failure changing: generated guids and embedded timestamps.
 * Transaction ids and constraint names are deliberately KEPT — two different
 * broken rows must not collapse into one fingerprint, or the second failure
 * would be silently suppressed by the first one's notification.
 */
export function normalizeErrorText(text: string): string {
  return text
    .replace(/\b[0-9a-f]{32}\b/gi, '<guid>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<ts>')
    .trim();
}

/**
 * Stable fingerprint of a sync's error set. A permanently failing transaction
 * produces the identical error every run, so the fingerprint is identical and
 * the caller's existence check dedupes it into ONE notification instead of a
 * fresh one every sync.
 *
 * FNV-1a (32-bit): deterministic, dependency-free, and short enough to keep
 * source_id well inside its varchar(255).
 */
export function simpleFinErrorFingerprint(errors: Array<{ account: string; error: string }>): string {
  const normalized = [...new Set(
    errors.map(err => `${err.account}: ${normalizeErrorText(err.error)}`),
  )].sort().join('\n');

  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
