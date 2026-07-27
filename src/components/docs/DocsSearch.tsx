'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { DocSearchEntry } from '@/lib/docs-content';

export function DocsSearch({
  entries,
  compact = false,
}: {
  entries: DocSearchEntry[];
  compact?: boolean;
}) {
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!normalized) return entries.slice(0, compact ? 5 : 8);
    return entries
      .filter((entry) =>
        `${entry.title} ${entry.summary} ${entry.category} ${entry.keywords ?? ''}`
          .toLowerCase()
          .includes(normalized),
      )
      .slice(0, 12);
  }, [compact, entries, normalized]);

  return (
    <div className="relative">
      <label className="sr-only" htmlFor={compact ? 'docs-search-compact' : 'docs-search'}>
        Search documentation
      </label>
      <input
        id={compact ? 'docs-search-compact' : 'docs-search'}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search workflows, features, and concepts"
        className="w-full rounded-md border border-border bg-input-bg px-4 py-3 text-sm text-foreground outline-none transition-colors duration-150 placeholder:text-foreground-muted focus:border-primary"
      />
      {(query || !compact) && (
        <div className={`${compact ? 'absolute left-0 right-0 top-[calc(100%+0.5rem)] z-30 shadow-2xl' : 'mt-3'} overflow-hidden rounded-md border border-border bg-surface-elevated`}>
          {results.length === 0 ? (
            <p className="px-4 py-5 text-sm text-foreground-muted">
              No documentation matches “{query}”.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {results.map((entry) => (
                <li key={entry.href}>
                  <Link
                    href={entry.href}
                    onClick={() => setQuery('')}
                    className="block px-4 py-3 transition-colors duration-150 hover:bg-surface-hover"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-semibold text-foreground">{entry.title}</span>
                      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-primary">
                        {entry.category}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-foreground-muted">{entry.summary}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
