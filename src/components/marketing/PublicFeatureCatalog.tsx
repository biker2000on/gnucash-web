'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { Feature, FeatureDomain } from '@/lib/feature-registry';

const DOMAIN_LABELS: Record<FeatureDomain, string> = {
  home: 'Financial command center',
  money: 'Accounting and records',
  budgets: 'Budgets and goals',
  investments: 'Investments',
  taxes: 'Taxes',
  planning: 'Planning and resilience',
  reports: 'Reports',
  business: 'Business operations',
  settings: 'Administration',
};

export function PublicFeatureCatalog({ features }: { features: Feature[] }) {
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLowerCase();
  const visible = useMemo(
    () => features.filter((feature) =>
      !normalized || `${feature.title} ${feature.description} ${feature.keywords ?? ''} ${feature.task}`
        .toLowerCase()
        .includes(normalized),
    ),
    [features, normalized],
  );
  const domains = [...new Set(features.map((feature) => feature.domain))];

  return (
    <>
      <div className="mt-8 max-w-2xl">
        <label htmlFor="feature-search" className="sr-only">Search all features</label>
        <input
          id="feature-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search features, reports, and workflows"
          className="w-full rounded-md border border-border bg-input-bg px-4 py-3 text-sm text-foreground outline-none transition-colors duration-150 placeholder:text-foreground-muted focus:border-primary"
        />
        <p className="mt-2 font-mono text-xs text-foreground-muted">
          {visible.length} of {features.length} registered capabilities
        </p>
      </div>

      <div className="mt-14 space-y-14">
        {domains.map((domain) => {
          const domainFeatures = visible.filter((feature) => feature.domain === domain);
          if (domainFeatures.length === 0) return null;
          return (
            <section key={domain}>
              <div className="flex items-baseline justify-between gap-4 border-b border-border pb-3">
                <h2 className="text-xl font-semibold text-foreground">{DOMAIN_LABELS[domain]}</h2>
                <span className="font-mono text-xs text-foreground-muted">{domainFeatures.length}</span>
              </div>
              <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
                {domainFeatures.map((feature) => (
                  <div key={feature.id} className="bg-surface p-5">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold text-foreground">{feature.title}</h3>
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">{feature.kind}</span>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-foreground-muted">{feature.description}</p>
                    <div className="mt-4 flex items-center justify-between gap-3">
                      <span className="text-xs text-foreground-muted">{feature.task}</span>
                      <Link href={`/docs/features/${feature.id}`} className="text-xs font-medium text-primary transition-colors duration-150 hover:text-primary-hover">
                        Learn how
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
