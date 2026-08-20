/**
 * MED-B — the batched comment-count lookup.
 *
 * Two failures lived in the old hook: it returned `{}` while any fetch was in
 * flight, so every badge on screen vanished and flashed back on each
 * infinite-scroll page; and it truncated the guid list at one batch, so rows
 * past 500 silently never got a badge at all.
 */

import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCommentCounts } from '../CommentCountBadge';

const guid = (n: number) => n.toString(16).padStart(32, '0');

/** Renders the hook and exposes its latest value plus a rerender handle. */
function harness() {
    const seen: Array<Record<string, number>> = [];
    function Probe({ guids }: { guids: string[] }) {
        seen.push(useCommentCounts(guids));
        return null;
    }
    const view = render(<Probe guids={[]} />);
    return {
        seen,
        latest: () => seen[seen.length - 1],
        show: (guids: string[]) => view.rerender(<Probe guids={guids} />),
    };
}

let requested: string[][];

beforeEach(() => {
    requested = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { txnGuids: string[] };
        requested.push(body.txnGuids);
        // Every guid in the batch has exactly one comment.
        const counts = Object.fromEntries(body.txnGuids.map(g => [g, 1]));
        return { ok: true, status: 200, json: async () => ({ counts }) } as Response;
    }));
});
afterEach(() => vi.unstubAllGlobals());

describe('delta fetching', () => {
    it('keeps the first page\'s counts while the second page loads', async () => {
        const page1 = [guid(1), guid(2)];
        const page2 = [...page1, guid(3)];
        const view = harness();

        await act(async () => { view.show(page1); });
        await waitFor(() => expect(view.latest()[guid(1)]).toBe(1));

        await act(async () => { view.show(page2); });
        // No render in between ever dropped the page-1 badges.
        expect(view.seen.every(counts => counts[guid(1)] === undefined || counts[guid(1)] === 1)).toBe(true);
        await waitFor(() => expect(view.latest()[guid(3)]).toBe(1));
        expect(view.latest()[guid(1)]).toBe(1);
        expect(view.latest()[guid(2)]).toBe(1);
    });

    it('asks only about the guids it has not seen', async () => {
        const view = harness();
        await act(async () => { view.show([guid(1), guid(2)]); });
        await waitFor(() => expect(requested).toHaveLength(1));

        await act(async () => { view.show([guid(1), guid(2), guid(3)]); });
        await waitFor(() => expect(requested).toHaveLength(2));
        expect(requested[1]).toEqual([guid(3)]);
    });
});

describe('batching past the endpoint cap', () => {
    it('splits 600 guids across two calls instead of dropping 100', async () => {
        const guids = Array.from({ length: 600 }, (_, i) => guid(i + 1));
        const view = harness();

        await act(async () => { view.show(guids); });
        await waitFor(() => expect(requested).toHaveLength(2));
        expect(requested[0]).toHaveLength(500);
        expect(requested[1]).toHaveLength(100);
        await waitFor(() => expect(view.latest()[guid(600)]).toBe(1));
    });
});
