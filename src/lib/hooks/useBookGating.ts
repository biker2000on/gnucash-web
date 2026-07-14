'use client';

/**
 * Client-side book gating state for the feature registry: whether the active
 * book is a business (hides personal-only features) and which business
 * feature modules are enabled (hides gated features like Invoices when
 * invoicing is off). One fetch of /api/book-features covers both; refetches
 * on 'entity-updated' and 'book-features-updated' window events.
 */

import { useEffect, useState } from 'react';
import type { Feature } from '@/lib/feature-registry';
import { isFeatureIdEnabled, type ResolvedBookFeatures } from '@/lib/book-features';

export interface BookGating {
    /** undefined while loading — callers should not filter until resolved. */
    businessBook?: boolean;
    /** Resolved feature-module map, or null while loading / on failure. */
    features: ResolvedBookFeatures | null;
}

export function useBookGating(): BookGating {
    const [gating, setGating] = useState<BookGating>({ features: null });

    useEffect(() => {
        let cancelled = false;
        const load = () => {
            fetch('/api/book-features')
                .then(res => (res.ok ? res.json() : null))
                .then(data => {
                    if (cancelled || !data?.entityType) return;
                    setGating({
                        businessBook: data.entityType !== 'household',
                        features: data.features ?? null,
                    });
                })
                .catch(() => { /* stay unfiltered on failure */ });
        };
        load();
        window.addEventListener('entity-updated', load);
        window.addEventListener('book-features-updated', load);
        return () => {
            cancelled = true;
            window.removeEventListener('entity-updated', load);
            window.removeEventListener('book-features-updated', load);
        };
    }, []);

    return gating;
}

/**
 * Whether a registry feature should be shown under the current gating state.
 * Mirrors featuresByDomain's opts semantics: household books hide
 * business-only features, business books hide personal-only features, and
 * disabled feature modules hide their gated business features.
 */
export function isFeatureVisible(
    feature: Feature,
    businessBook: boolean | undefined,
    features: ResolvedBookFeatures | null,
): boolean {
    if (businessBook === false && feature.businessOnly) return false;
    if (businessBook === true && feature.personalOnly) return false;
    if (features && !isFeatureIdEnabled(feature.id, features)) return false;
    return true;
}
