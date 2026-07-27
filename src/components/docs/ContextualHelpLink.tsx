'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { resolveFeatureForPath } from '@/lib/docs-reference';

export function ContextualHelpLink() {
  const pathname = usePathname();
  const feature = resolveFeatureForPath(pathname ?? '/');
  const href = feature ? `/docs/features/${feature.id}` : '/docs';
  const label = feature ? `Help for ${feature.title}` : 'Open documentation';

  return (
    <Link
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={label}
      className="inline-flex min-h-9 items-center gap-2 rounded-md border border-border px-2.5 text-sm font-medium text-foreground-secondary transition-colors duration-150 hover:border-border-hover hover:bg-surface-hover hover:text-foreground"
    >
      <svg
        aria-hidden
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        viewBox="0 0 24 24"
      >
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" d="M9.75 9a2.25 2.25 0 114.04 1.37c-.87 1.13-1.79 1.35-1.79 2.63" />
        <path strokeLinecap="round" d="M12 17h.01" />
      </svg>
      <span className="hidden lg:inline">Help</span>
    </Link>
  );
}
