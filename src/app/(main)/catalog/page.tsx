'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { KindBadge } from '@/components/hub/DomainFeatureSections';
import {
    FEATURES,
    DOMAIN_LABELS,
    NAV_DOMAIN_ORDER,
    type Feature,
} from '@/lib/feature-registry';

function matchesQuery(feature: Feature, query: string): boolean {
    if (!query) return true;
    const haystack = [
        feature.title,
        feature.description,
        feature.keywords ?? '',
        feature.task,
        DOMAIN_LABELS[feature.domain],
    ]
        .join(' ')
        .toLowerCase();
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every(term => haystack.includes(term));
}

function PinButton({
    pinned,
    onToggle,
    title,
}: {
    pinned: boolean;
    onToggle: () => void;
    title: string;
}) {
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-pressed={pinned}
            aria-label={pinned ? `Unpin ${title}` : `Pin ${title}`}
            title={pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
            className={`shrink-0 p-1 rounded transition-colors duration-150 ${
                pinned
                    ? 'text-primary hover:text-primary-hover'
                    : 'text-foreground-muted hover:text-foreground'
            }`}
        >
            <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill={pinned ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth={1.8}
            >
                <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M11.48 3.5c.2-.62.85-.62 1.04 0l1.83 5.63a.56.56 0 00.53.38h5.92c.65 0 .92.83.4 1.21l-4.79 3.48a.56.56 0 00-.2.63l1.83 5.62c.2.62-.51 1.14-1.04.76l-4.78-3.48a.56.56 0 00-.66 0l-4.79 3.48c-.52.38-1.24-.14-1.03-.76l1.83-5.62a.56.56 0 00-.21-.63L2.6 10.72c-.52-.38-.25-1.21.4-1.21h5.92a.56.56 0 00.53-.38l1.83-5.62z"
                />
            </svg>
        </button>
    );
}

function CatalogCard({
    feature,
    pinned,
    onTogglePin,
}: {
    feature: Feature;
    pinned: boolean;
    onTogglePin: (id: string) => void;
}) {
    return (
        <div className="flex items-start gap-1 min-w-0 px-3 py-2.5 rounded-lg border border-border bg-surface hover:border-border-hover transition-colors duration-150">
            <Link href={feature.href} className="flex-1 min-w-0 group">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors duration-150">
                        {feature.title}
                    </span>
                    <KindBadge kind={feature.kind} />
                </div>
                <p className="text-xs text-foreground-muted mt-0.5 line-clamp-2">
                    {feature.description}
                </p>
            </Link>
            <PinButton
                pinned={pinned}
                onToggle={() => onTogglePin(feature.id)}
                title={feature.title}
            />
        </div>
    );
}

export default function CatalogPage() {
    const [query, setQuery] = useState('');
    const [pinned, setPinned] = useState<string[]>([]);

    // Load pinned feature ids.
    useEffect(() => {
        let cancelled = false;
        fetch('/api/user/preferences?key=pinned_features')
            .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
            .then(data => {
                if (cancelled) return;
                const pins = data?.preferences?.pinned_features;
                if (Array.isArray(pins)) setPinned(pins.filter((p): p is string => typeof p === 'string'));
            })
            .catch(() => {
                /* pinning degrades gracefully */
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const togglePin = useCallback((id: string) => {
        const prev = pinned;
        const next = prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id];
        setPinned(next);
        fetch('/api/user/preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preferences: { pinned_features: next } }),
        })
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                window.dispatchEvent(new CustomEvent('pinned-features-changed'));
            })
            .catch(() => {
                // Revert on save failure.
                setPinned(prev);
            });
    }, [pinned]);

    const filtered = useMemo(
        () => FEATURES.filter(f => matchesQuery(f, query)),
        [query],
    );

    const pinnedFeatures = useMemo(
        () => filtered.filter(f => pinned.includes(f.id)),
        [filtered, pinned],
    );

    const domainGroups = useMemo(
        () =>
            NAV_DOMAIN_ORDER.map(domain => ({
                domain,
                label: DOMAIN_LABELS[domain],
                items: filtered.filter(f => f.domain === domain),
            })).filter(g => g.items.length > 0),
        [filtered],
    );

    return (
        <div className="space-y-6">
            <PageHeader
                title="Feature Catalog"
                subtitle="Everything this app can do. Pin the features you use most — they appear in the sidebar."
                toolbar={
                    <input
                        type="search"
                        data-search-input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search features… ( / )"
                        className="w-full sm:w-80 px-3 py-2 text-sm bg-surface border border-border rounded-md text-foreground placeholder:text-foreground-muted focus:outline-none focus:border-primary transition-colors duration-150"
                    />
                }
            />

            {pinnedFeatures.length > 0 && (
                <section>
                    <h2 className="text-[10px] uppercase tracking-wider text-foreground-muted mb-2">
                        Pinned
                    </h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {pinnedFeatures.map(f => (
                            <CatalogCard
                                key={f.id}
                                feature={f}
                                pinned
                                onTogglePin={togglePin}
                            />
                        ))}
                    </div>
                </section>
            )}

            {domainGroups.map(group => (
                <section key={group.domain}>
                    <h2 className="text-[10px] uppercase tracking-wider text-foreground-muted mb-2">
                        {group.label}
                    </h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {group.items.map(f => (
                            <CatalogCard
                                key={f.id}
                                feature={f}
                                pinned={pinned.includes(f.id)}
                                onTogglePin={togglePin}
                            />
                        ))}
                    </div>
                </section>
            ))}

            {filtered.length === 0 && (
                <p className="text-sm text-foreground-muted">
                    No features match &ldquo;{query}&rdquo;.
                </p>
            )}
        </div>
    );
}
