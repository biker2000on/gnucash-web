import Link from 'next/link';
import { featureById, type Feature } from '@/lib/feature-registry';

interface RelatedLinksProps {
    /** Feature-registry ids to link to. Unknown ids are skipped. */
    ids: string[];
    title?: string;
}

/**
 * Compact horizontal strip of "where to go next" chips, resolved from the
 * feature registry. Renders nothing when no ids resolve.
 */
export function RelatedLinks({ ids, title = 'Related' }: RelatedLinksProps) {
    const features = ids
        .map(id => featureById(id))
        .filter((f): f is Feature => f !== undefined);

    if (features.length === 0) return null;

    return (
        <nav aria-label={title} className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-foreground-muted">
                {title}
            </span>
            {features.map(f => (
                <Link
                    key={f.id}
                    href={f.href}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border bg-surface text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors duration-150"
                >
                    {f.title}
                    <span aria-hidden className="text-foreground-muted">&rarr;</span>
                </Link>
            ))}
        </nav>
    );
}
