'use client';

import Link from 'next/link';
import { FILING_STATUS_LABELS, type FilingStatus } from '@/lib/tax/types';

/**
 * Divergence marker for filing-status selectors.
 *
 * The household/entity profile is the single source of truth for filing
 * status; a surface-local selector is a scenario override. While the local
 * value matches the household setting (inherited state) this renders
 * nothing. When it diverges, a small warning note makes the override
 * explicit, links to Settings, and (optionally) offers a one-click return
 * to the inherited value.
 */
export function FilingStatusSourceNote({
  value,
  householdValue,
  onUseHousehold,
}: {
  /** The surface's effective filing status. */
  value: FilingStatus;
  /** The household profile's filing status (null = unset/loading). */
  householdValue: FilingStatus | null;
  /** Reset the surface to inherited state. Omitted = no reset affordance. */
  onUseHousehold?: () => void;
}) {
  if (householdValue === null || value === householdValue) return null;

  return (
    <p role="note" className="mt-1 text-[11px] text-warning">
      Differs from the household setting ({FILING_STATUS_LABELS[householdValue]}).{' '}
      {onUseHousehold && (
        <>
          <button
            type="button"
            onClick={onUseHousehold}
            className="underline underline-offset-2 hover:text-foreground transition-colors duration-150"
          >
            Use household setting
          </button>
          {' · '}
        </>
      )}
      <Link
        href="/settings"
        className="text-primary hover:text-primary-hover underline underline-offset-2 transition-colors duration-150"
      >
        Settings
      </Link>
    </p>
  );
}
