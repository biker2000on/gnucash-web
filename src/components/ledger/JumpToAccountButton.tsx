'use client';

import { useRouter } from 'next/navigation';

interface JumpToAccountButtonProps {
  /** GUID of the account to jump to. */
  accountGuid: string;
  /** Account name/path, used for the tooltip and accessible label. */
  accountLabel?: string;
  className?: string;
}

/**
 * Small icon button that navigates to another account's ledger. Rendered on
 * each split line in the register so the user can "jump" to the other account
 * on a highlighted line (mirrors GnuCash desktop's Jump action). Uses a
 * <button> so the row-level onClick (which ignores clicks on buttons) does not
 * also fire.
 */
export function JumpToAccountButton({ accountGuid, accountLabel, className = '' }: JumpToAccountButtonProps) {
  const router = useRouter();
  const label = accountLabel ? `Jump to ${accountLabel}` : 'Jump to account';

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        router.push(`/accounts/${accountGuid}`);
      }}
      className={`inline-flex items-center justify-center w-4 h-4 shrink-0 text-foreground-muted opacity-0 group-hover:opacity-100 hover:text-primary focus:opacity-100 focus:text-primary transition-opacity ${className}`}
    >
      <svg viewBox="0 0 20 20" fill="none" className="w-3.5 h-3.5" aria-hidden="true">
        <path d="M7 13L13 7M13 7H8M13 7V12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
