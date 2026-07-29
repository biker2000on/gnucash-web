'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  DOMAIN_LABELS,
  type Feature,
  type FeatureDomain,
} from '@/lib/feature-registry';

interface DomainGroup {
  domain: FeatureDomain;
  features: Feature[];
}

export function DocsFeatureIndex({ groups }: { groups: DomainGroup[] }) {
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLowerCase();
  const visibleGroups = useMemo(
    () => groups
      .map((group) => ({
        ...group,
        features: group.features.filter((feature) =>
          !normalized ||
          `${feature.title} ${feature.description} ${feature.task} ${feature.kind} ${feature.keywords ?? ''}`
            .toLowerCase()
            .includes(normalized),
        ),
      }))
      .filter((group) => group.features.length > 0),
    [groups, normalized],
  );
  const total = groups.reduce((sum, group) => sum + group.features.length, 0);
  const visible = visibleGroups.reduce((sum, group) => sum + group.features.length, 0);

  return (
    <>
      <div className="mt-8 max-w-2xl">
        <label htmlFor="docs-feature-search" className="sr-only">
          Search feature reference
        </label>
        <input
          id="docs-feature-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the feature reference"
          className="w-full rounded-md border border-border bg-input-bg px-4 py-3 text-sm text-foreground outline-none transition-colors duration-150 placeholder:text-foreground-muted focus:border-primary"
        />
        <p className="mt-2 font-mono text-xs text-foreground-muted">
          {visible} of {total} feature guides
        </p>
      </div>

      <div className="mt-12 space-y-12">
        {visibleGroups.map((group) => (
          <section key={group.domain}>
            <div className="flex items-baseline justify-between gap-4 border-b border-border pb-3">
              <h2 className="text-xl font-semibold text-foreground">{DOMAIN_LABELS[group.domain]}</h2>
              <span className="font-mono text-xs text-foreground-muted">{group.features.length}</span>
            </div>
            <div className="divide-y divide-border">
              {group.features.map((feature) => (
                <div
                  key={feature.id}
                  className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/docs/features/${feature.id}`}
                        className="font-semibold text-foreground transition-colors duration-150 hover:text-primary"
                      >
                        {feature.title}
                      </Link>
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                        {feature.kind}
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-foreground-muted">
                      {feature.description}
                    </p>
                  </div>
                  <Link
                    href={feature.href}
                    className="text-xs font-medium text-foreground-secondary transition-colors duration-150 hover:text-primary"
                  >
                    Open in app
                  </Link>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
