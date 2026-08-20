'use client';

import { useEffect, useState } from 'react';
import { Tip } from '@/components/ui/Tooltip';

/**
 * Comment-count badges for ledger and journal rows.
 *
 * The counts come from ONE batched call per page of rows
 * (`POST /api/transactions/comment-counts`) rather than from the transaction
 * list routes: the list endpoints are shared by many surfaces and did not need
 * a new join, and a per-row request would be 50+ round trips for a decoration.
 */

/** Guids the endpoint accepts in one call (mirrors the route's own cap). */
const MAX_BATCH = 500;

/** Stable empty result, so an unfetched render does not churn identity. */
const EMPTY_RESULT = { key: '', counts: {} as Record<string, number> };

/**
 * Counts keyed by transaction guid. Only transactions that actually have
 * comments appear, so `counts[guid]` is `undefined` for the common case and
 * the badge renders exactly when a guid is present.
 */
export function useCommentCounts(txnGuids: string[]): Record<string, number> {
    // Counts are stored WITH the guid set they were fetched for, so a page
    // that has moved on renders no badges rather than the previous page's.
    const [loaded, setLoaded] = useState<{ key: string; counts: Record<string, number> }>(EMPTY_RESULT);
    // The guid list is a fresh array on every render of the parent; keying the
    // effect on its joined identity is what stops an endless fetch loop.
    const key = txnGuids.join(',');

    useEffect(() => {
        const guids = key === '' ? [] : key.split(',').slice(0, MAX_BATCH);
        if (guids.length === 0) return;
        let cancelled = false;
        void (async () => {
            try {
                const response = await fetch('/api/transactions/comment-counts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ txnGuids: guids }),
                });
                if (!response.ok) return;
                const body = await response.json();
                if (cancelled) return;
                setLoaded({ key, counts: body.counts ?? {} });
            } catch {
                // A decoration must never take the ledger down with it; the
                // rows simply render without badges.
            }
        })();
        return () => { cancelled = true; };
    }, [key]);

    return loaded.key === key ? loaded.counts : EMPTY_RESULT.counts;
}

/**
 * The badge itself. Renders nothing at zero — an empty affordance on every row
 * of a dense ledger is noise, and the discussion is reachable from the row's
 * detail view either way.
 */
export function CommentCountBadge({ count }: { count: number }) {
    if (!count || count < 1) return null;
    const label = `${count} comment${count === 1 ? '' : 's'}`;
    return (
        <Tip content={`${label} — open the transaction to read the thread`}>
            <span
                className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-xs text-foreground-secondary"
                aria-label={label}
            >
                <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="font-mono">{count}</span>
            </span>
        </Tip>
    );
}
