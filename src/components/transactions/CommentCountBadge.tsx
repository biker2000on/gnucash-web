'use client';

import { useEffect, useRef, useState } from 'react';
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

/**
 * Counts keyed by transaction guid. Only transactions that actually have
 * comments appear, so `counts[guid]` is `undefined` for the common case and
 * the badge renders exactly when a guid is present.
 *
 * Accumulating, and fetched by delta. Two behaviours depend on it:
 *
 *  - Infinite scroll appends rows, so the guid list grows on every page. Only
 *    the guids never asked about are sent, and results are merged into what is
 *    already known — the previous implementation re-fetched the whole list and
 *    returned `{}` until it landed, which blanked every badge on screen and
 *    then flashed them back on each page.
 *  - A list longer than one batch is split across several calls instead of
 *    being truncated at 500, where the rows past the cap silently never got a
 *    badge at all.
 */
export function useCommentCounts(txnGuids: string[]): Record<string, number> {
    const [counts, setCounts] = useState<Record<string, number>>({});
    // Guids already asked about (whatever the answer). A guid with no comments
    // is absent from `counts`, so this is the only record that it was fetched.
    const asked = useRef<Set<string>>(new Set());
    // The guid list is a fresh array on every render of the parent; keying the
    // effect on its joined identity is what stops an endless fetch loop.
    const key = txnGuids.join(',');

    useEffect(() => {
        const pending = (key === '' ? [] : key.split(','))
            .filter(guid => guid !== '' && !asked.current.has(guid));
        if (pending.length === 0) return;
        const unique = [...new Set(pending)];
        // Claimed before the request so a re-render mid-flight does not ask again.
        for (const guid of unique) asked.current.add(guid);

        let cancelled = false;
        void (async () => {
            for (let start = 0; start < unique.length; start += MAX_BATCH) {
                const batch = unique.slice(start, start + MAX_BATCH);
                try {
                    const response = await fetch('/api/transactions/comment-counts', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ txnGuids: batch }),
                    });
                    if (cancelled) return;
                    if (!response.ok) {
                        // Release the claim so a later render can retry.
                        for (const guid of batch) asked.current.delete(guid);
                        continue;
                    }
                    const body = await response.json();
                    if (cancelled) return;
                    const fresh = (body.counts ?? {}) as Record<string, number>;
                    if (Object.keys(fresh).length === 0) continue;
                    setCounts(previous => ({ ...previous, ...fresh }));
                } catch {
                    // A decoration must never take the ledger down with it; the
                    // rows simply render without badges.
                    for (const guid of batch) asked.current.delete(guid);
                }
            }
        })();
        return () => { cancelled = true; };
    }, [key]);

    return counts;
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
