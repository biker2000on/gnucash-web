'use client';

import Link from 'next/link';
import {
    featuresByDomain,
    type Feature,
    type FeatureDomain,
    type FeatureKind,
} from '@/lib/feature-registry';
import { isFeatureIdEnabled } from '@/lib/book-features';
import { useBookGating } from '@/lib/hooks/useBookGating';

const KIND_LABEL: Record<FeatureKind, string> = {
    page: 'Page',
    report: 'Report',
    tool: 'Tool',
    action: 'Action',
};

const KIND_CLASS: Record<FeatureKind, string> = {
    page: 'text-foreground-muted border-border',
    report: 'text-secondary border-secondary/30',
    tool: 'text-primary border-primary/30',
    action: 'text-foreground-muted border-border',
};

/** Tiny report/tool/page badge, shared by the hubs and the catalog. */
export function KindBadge({ kind }: { kind: FeatureKind }) {
    return (
        <span
            className={`shrink-0 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border ${KIND_CLASS[kind]}`}
        >
            {KIND_LABEL[kind]}
        </span>
    );
}

/** One clickable feature card: title, kind badge, one-line description. */
export function FeatureCard({ feature }: { feature: Feature }) {
    return (
        <Link
            href={feature.href}
            className="block min-w-0 px-3 py-2.5 rounded-lg border border-border bg-surface hover:border-border-hover hover:bg-surface-hover transition-colors duration-150"
        >
            <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground truncate">
                    {feature.title}
                </span>
                <KindBadge kind={feature.kind} />
            </div>
            <p className="text-xs text-foreground-muted mt-0.5 line-clamp-2">
                {feature.description}
            </p>
        </Link>
    );
}

/**
 * All of a domain's features grouped by task (section headings in registry
 * order). Used by the /money, /taxes, and /planning hub pages. Gated by the
 * active book: business books hide personal-only features, and disabled
 * feature modules hide their gated business features.
 */
export function DomainFeatureSections({ domain }: { domain: FeatureDomain }) {
    const { businessBook, features: bookFeatures } = useBookGating();
    const features = featuresByDomain(domain, {
        businessBook,
        enabledFeatureIds: bookFeatures
            ? id => isFeatureIdEnabled(id, bookFeatures)
            : undefined,
    });

    // Group by task, preserving registry order of first appearance.
    const groups: { task: string; items: Feature[] }[] = [];
    for (const f of features) {
        let group = groups.find(g => g.task === f.task);
        if (!group) {
            group = { task: f.task, items: [] };
            groups.push(group);
        }
        group.items.push(f);
    }

    return (
        <div className="space-y-6">
            {groups.map(group => (
                <section key={group.task}>
                    <h2 className="text-[10px] uppercase tracking-wider text-foreground-muted mb-2">
                        {group.task}
                    </h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {group.items.map(f => (
                            <FeatureCard key={f.id} feature={f} />
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}
