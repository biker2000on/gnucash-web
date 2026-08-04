/**
 * Filing-status inheritance seam — pure, client-safe.
 *
 * `gnucash_web_entity_profiles.filing_status` (the household/entity profile,
 * edited in Settings → Household & entity) is the single source of truth for
 * filing status. Every tax surface seeds from it by default; a surface-local
 * selector is an explicit, visually-marked scenario override — never a
 * silently divergent stored copy. This module owns the resolution rules so
 * all surfaces model inherited vs override state identically (the same
 * pattern as household-roster resolution).
 *
 * The pure tax engines (`computeFederalTax` and friends) still take
 * `filingStatus` as a plain input — this seam only decides where that value
 * comes from.
 */

import { FILING_STATUSES, type FilingStatus } from './types';

/** Where an effective filing status came from. */
export type FilingStatusSource = 'override' | 'household' | 'default';

export interface FilingStatusResolution {
  /** The value to feed the tax engines. */
  effective: FilingStatus;
  source: FilingStatusSource;
  /**
   * True when a stored/local value disagrees with the household profile —
   * surfaces must show the divergence note instead of silently rewriting
   * (or silently trusting) the stored copy.
   */
  divergesFromHousehold: boolean;
}

/** Parse an unknown value into a FilingStatus, else null. */
export function normalizeFilingStatus(value: unknown): FilingStatus | null {
  return typeof value === 'string' &&
    (FILING_STATUSES as readonly string[]).includes(value)
    ? (value as FilingStatus)
    : null;
}

/**
 * Resolve the effective filing status from a stored/local value (a persisted
 * tool config or in-memory selector state) and the household profile value.
 *
 * - No stored value → inherit the household setting (or `fallback`).
 * - Stored value equal to the household setting → inherited, NOT an
 *   override (redundant copies collapse back to inherited state).
 * - Stored value different from the household setting → explicit override,
 *   flagged via `divergesFromHousehold` so the surface shows the mismatch
 *   note rather than guessing.
 */
export function resolveFilingStatus(
  stored: unknown,
  household: unknown,
  fallback: FilingStatus = 'single',
): FilingStatusResolution {
  const storedFs = normalizeFilingStatus(stored);
  const householdFs = normalizeFilingStatus(household);

  if (storedFs !== null) {
    if (householdFs === null) {
      // No household setting to inherit from — the stored value stands on
      // its own and there is nothing to diverge from.
      return { effective: storedFs, source: 'override', divergesFromHousehold: false };
    }
    if (storedFs === householdFs) {
      return { effective: householdFs, source: 'household', divergesFromHousehold: false };
    }
    return { effective: storedFs, source: 'override', divergesFromHousehold: true };
  }

  if (householdFs !== null) {
    return { effective: householdFs, source: 'household', divergesFromHousehold: false };
  }
  return { effective: fallback, source: 'default', divergesFromHousehold: false };
}

/**
 * Turn a selector change into override state: choosing the household's own
 * value returns the surface to inherited state (null); anything else is an
 * explicit override.
 */
export function applyFilingStatusSelection(
  selected: FilingStatus,
  household: FilingStatus | null,
): FilingStatus | null {
  return household !== null && selected === household ? null : selected;
}

/**
 * What (if anything) a surface should persist for its filing status: only
 * true overrides are stored — inherited state persists nothing, so a later
 * change to the household setting ripples through automatically.
 */
export function filingStatusOverrideToPersist(
  local: FilingStatus,
  household: FilingStatus | null,
): FilingStatus | undefined {
  return household !== null && local === household ? undefined : local;
}
