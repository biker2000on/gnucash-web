/**
 * Quick-Add Offline Queue tests
 *
 * The queue core is storage-agnostic, so these tests run it against the
 * in-memory storage backend with injected fetch implementations — no real
 * IndexedDB (and no fake-indexeddb dependency) needed.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    buildQuickAddTransaction,
    createInMemoryStorage,
    createQuickAddQueue,
    postQuickAdd,
    QueuedQuickAdd,
} from '@/lib/quick-add-queue';
import type { CreateTransactionRequest } from '@/lib/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GUID_RE = /^[a-f0-9]{32}$/;

function makePayload(): CreateTransactionRequest {
    return buildQuickAddTransaction({
        kind: 'expense',
        amount: 12.34,
        accountGuid: 'a'.repeat(32),
        categoryGuid: 'b'.repeat(32),
        currencyGuid: 'c'.repeat(32),
        description: 'Coffee',
        postDate: '2026-07-12',
    });
}

function fakeResponse(status: number, body = ''): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
    } as unknown as Response;
}

function fetchReturning(status: number, body = ''): typeof fetch {
    return (async () => fakeResponse(status, body)) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// buildQuickAddTransaction — offline payload correctness
// ---------------------------------------------------------------------------

describe('buildQuickAddTransaction', () => {
    it('builds a balanced 2-split expense with a client-generated guid', () => {
        const tx = buildQuickAddTransaction({
            kind: 'expense',
            amount: 12.34,
            accountGuid: 'a'.repeat(32),
            categoryGuid: 'b'.repeat(32),
            currencyGuid: 'c'.repeat(32),
            description: 'Coffee',
            postDate: '2026-07-12',
        });

        expect(tx.guid).toMatch(GUID_RE);
        expect(tx.currency_guid).toBe('c'.repeat(32));
        expect(tx.post_date).toBe('2026-07-12');
        expect(tx.description).toBe('Coffee');
        expect(tx.splits).toHaveLength(2);

        const [assetSplit, categorySplit] = tx.splits;
        // Expense: money leaves the asset account (negative), lands in the category (positive)
        expect(assetSplit.account_guid).toBe('a'.repeat(32));
        expect(assetSplit.value_num).toBe(-1234);
        expect(assetSplit.value_denom).toBe(100);
        expect(categorySplit.account_guid).toBe('b'.repeat(32));
        expect(categorySplit.value_num).toBe(1234);
        expect(categorySplit.value_denom).toBe(100);

        // Balanced: values sum to exactly zero
        expect(assetSplit.value_num + categorySplit.value_num).toBe(0);

        // Same-currency: quantity mirrors value
        for (const split of tx.splits) {
            expect(split.quantity_num).toBe(split.value_num);
            expect(split.quantity_denom).toBe(split.value_denom);
            expect(split.guid).toMatch(GUID_RE);
            expect(split.reconcile_state).toBe('n');
        }
    });

    it('reverses split direction for income', () => {
        const tx = buildQuickAddTransaction({
            kind: 'income',
            amount: 500,
            accountGuid: 'a'.repeat(32),
            categoryGuid: 'b'.repeat(32),
            currencyGuid: 'c'.repeat(32),
            description: 'Paycheck',
        });

        const [assetSplit, categorySplit] = tx.splits;
        // Income: money arrives into the asset account (positive); income account is negative
        expect(assetSplit.value_num).toBe(50000);
        expect(categorySplit.value_num).toBe(-50000);
        expect(assetSplit.value_num + categorySplit.value_num).toBe(0);
    });

    it('generates a fresh transaction guid per call', () => {
        const a = makePayload();
        const b = makePayload();
        expect(a.guid).not.toBe(b.guid);
    });

    it('defaults the description when blank', () => {
        const tx = buildQuickAddTransaction({
            kind: 'expense',
            amount: 1,
            accountGuid: 'a'.repeat(32),
            categoryGuid: 'b'.repeat(32),
            currencyGuid: 'c'.repeat(32),
            description: '   ',
        });
        expect(tx.description).toBe('Quick add');
    });

    it('rejects non-positive amounts and identical accounts', () => {
        expect(() =>
            buildQuickAddTransaction({
                kind: 'expense',
                amount: 0,
                accountGuid: 'a'.repeat(32),
                categoryGuid: 'b'.repeat(32),
                currencyGuid: 'c'.repeat(32),
            })
        ).toThrow(/greater than zero/);

        expect(() =>
            buildQuickAddTransaction({
                kind: 'expense',
                amount: 5,
                accountGuid: 'a'.repeat(32),
                categoryGuid: 'a'.repeat(32),
                currencyGuid: 'c'.repeat(32),
            })
        ).toThrow(/different/);
    });
});

// ---------------------------------------------------------------------------
// Queue basics
// ---------------------------------------------------------------------------

describe('quick-add queue', () => {
    it('enqueue → listPending returns the queued item', async () => {
        const queue = createQuickAddQueue(createInMemoryStorage());
        const payload = makePayload();

        const item = await queue.enqueue(payload);
        expect(item.localId).toBeTruthy();
        expect(item.status).toBe('pending');
        expect(item.createdAt).toBeTruthy();

        const pending = await queue.listPending();
        expect(pending).toHaveLength(1);
        expect(pending[0].localId).toBe(item.localId);
        expect(pending[0].payload).toEqual(payload);
    });

    it('lists items oldest-first and supports remove', async () => {
        const queue = createQuickAddQueue(createInMemoryStorage());
        const first = await queue.enqueue(makePayload());
        const second = await queue.enqueue(makePayload());

        let all = await queue.listAll();
        expect(all.map(i => i.localId)).toContain(first.localId);
        expect(all).toHaveLength(2);

        await queue.remove(first.localId);
        all = await queue.listAll();
        expect(all).toHaveLength(1);
        expect(all[0].localId).toBe(second.localId);
    });

    it('markSyncing / markFailed update status and error', async () => {
        const queue = createQuickAddQueue(createInMemoryStorage());
        const item = await queue.enqueue(makePayload());

        await queue.markSyncing(item.localId);
        expect((await queue.listAll())[0].status).toBe('syncing');
        expect(await queue.listPending()).toHaveLength(0);

        await queue.markFailed(item.localId, 'boom');
        const failed = (await queue.listAll())[0];
        expect(failed.status).toBe('failed');
        expect(failed.error).toBe('boom');

        await queue.retry(item.localId);
        const retried = (await queue.listAll())[0];
        expect(retried.status).toBe('pending');
        expect(retried.error).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// syncAll
// ---------------------------------------------------------------------------

describe('syncAll', () => {
    it('posts each pending item and removes it on success', async () => {
        const queue = createQuickAddQueue(createInMemoryStorage());
        const p1 = makePayload();
        const p2 = makePayload();
        await queue.enqueue(p1);
        await queue.enqueue(p2);

        const posted: string[] = [];
        const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as CreateTransactionRequest;
            posted.push(body.guid!);
            return fakeResponse(201);
        }) as unknown as typeof fetch;

        const result = await queue.syncAll(fetchImpl);

        expect(result).toEqual({ synced: 2, failed: 0, remaining: 0 });
        expect(posted.sort()).toEqual([p1.guid, p2.guid].sort());
        expect(await queue.listAll()).toHaveLength(0);
    });

    it('marks items failed with the error message when the POST fails', async () => {
        const queue = createQuickAddQueue(createInMemoryStorage());
        await queue.enqueue(makePayload());

        const result = await queue.syncAll(
            fetchReturning(500, '{"error":"Failed to create transaction"}')
        );

        expect(result.synced).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.remaining).toBe(1);

        const [item] = await queue.listAll();
        expect(item.status).toBe('failed');
        expect(item.error).toContain('HTTP 500');
        expect(item.error).toContain('Failed to create transaction');
    });

    it('marks items failed on network errors', async () => {
        const queue = createQuickAddQueue(createInMemoryStorage());
        await queue.enqueue(makePayload());

        const fetchImpl = (async () => {
            throw new Error('Failed to fetch');
        }) as unknown as typeof fetch;

        const result = await queue.syncAll(fetchImpl);
        expect(result.failed).toBe(1);
        const [item] = await queue.listAll();
        expect(item.status).toBe('failed');
        expect(item.error).toBe('Failed to fetch');
    });

    it('treats 409 responses as already-synced and removes the item', async () => {
        const queue = createQuickAddQueue(createInMemoryStorage());
        await queue.enqueue(makePayload());

        const result = await queue.syncAll(fetchReturning(409, 'Conflict'));

        expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });
        expect(await queue.listAll()).toHaveLength(0);
    });

    it('treats duplicate-guid error bodies as already-synced', async () => {
        const queue = createQuickAddQueue(createInMemoryStorage());
        await queue.enqueue(makePayload());

        const result = await queue.syncAll(
            fetchReturning(500, 'Unique constraint failed on the fields: (`guid`)')
        );

        expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });
        expect(await queue.listAll()).toHaveLength(0);
    });

    it('skips failed items by default but retries them with includeFailed', async () => {
        const queue = createQuickAddQueue(createInMemoryStorage());
        const item = await queue.enqueue(makePayload());
        await queue.markFailed(item.localId, 'earlier failure');

        const fetchImpl = vi.fn(fetchReturning(201));
        let result = await queue.syncAll(fetchImpl as unknown as typeof fetch);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(result).toEqual({ synced: 0, failed: 0, remaining: 1 });

        result = await queue.syncAll(fetchImpl as unknown as typeof fetch, {
            includeFailed: true,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });
    });

    it('is idempotent under concurrent double-sync (same guid posted once)', async () => {
        const queue = createQuickAddQueue(createInMemoryStorage());
        const payload = makePayload();
        await queue.enqueue(payload);

        const postedGuids: string[] = [];
        const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
            // Simulate network latency so the two syncAll calls overlap
            await new Promise(resolve => setTimeout(resolve, 10));
            const body = JSON.parse(String(init?.body)) as CreateTransactionRequest;
            postedGuids.push(body.guid!);
            return fakeResponse(201);
        }) as unknown as typeof fetch;

        const [r1, r2] = await Promise.all([queue.syncAll(fetchImpl), queue.syncAll(fetchImpl)]);

        // The overlapping call joins the in-flight run: one POST total
        expect(postedGuids).toEqual([payload.guid]);
        expect(r1).toEqual(r2);
        expect(await queue.listAll()).toHaveLength(0);
    });

    it('a second sequential sync after success posts nothing (queue drained)', async () => {
        const queue = createQuickAddQueue(createInMemoryStorage());
        await queue.enqueue(makePayload());

        const fetchImpl = vi.fn(fetchReturning(201));
        await queue.syncAll(fetchImpl as unknown as typeof fetch);
        await queue.syncAll(fetchImpl as unknown as typeof fetch);

        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('survives double-sync from two queue instances via server-side guid idempotency', async () => {
        // Two tabs sharing one storage: the "server" accepts the first POST for
        // a guid and 409s the rest — both tabs end up with an empty queue and
        // exactly one stored transaction.
        const storage = createInMemoryStorage();
        const tabA = createQuickAddQueue(storage);
        const tabB = createQuickAddQueue(storage);
        const payload = makePayload();
        const item = await tabA.enqueue(payload);

        // Tab A synced already but crashed before deleting; item got reset to pending.
        const serverGuids = new Set<string>();
        const serverFetch = (async (_url: unknown, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as CreateTransactionRequest;
            if (serverGuids.has(body.guid!)) return fakeResponse(409, 'duplicate');
            serverGuids.add(body.guid!);
            return fakeResponse(201);
        }) as unknown as typeof fetch;

        await tabA.syncAll(serverFetch);
        // Simulate the item lingering (e.g. delete lost) and being re-synced
        await storage.put({ ...item, status: 'pending' } as QueuedQuickAdd);
        const result = await tabB.syncAll(serverFetch);

        expect(serverGuids.size).toBe(1); // transaction exists exactly once
        expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });
        expect(await tabB.listAll()).toHaveLength(0);
    });

    it('skips items another sync already marked as syncing', async () => {
        const queue = createQuickAddQueue(createInMemoryStorage());
        const item = await queue.enqueue(makePayload());
        // Simulate another tab holding the item mid-sync. listAll sees it as a
        // candidate only when pending, so force the race window explicitly:
        await queue.markSyncing(item.localId);

        const fetchImpl = vi.fn(fetchReturning(201));
        const result = await queue.syncAll(fetchImpl as unknown as typeof fetch);

        expect(fetchImpl).not.toHaveBeenCalled();
        expect(result.synced).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// postQuickAdd classification
// ---------------------------------------------------------------------------

describe('postQuickAdd', () => {
    it('reports synced on 2xx', async () => {
        const result = await postQuickAdd(makePayload(), fetchReturning(201));
        expect(result).toEqual({ synced: true });
    });

    it('reports synced on 409', async () => {
        const result = await postQuickAdd(makePayload(), fetchReturning(409));
        expect(result).toEqual({ synced: true });
    });

    it('reports an error with status and body otherwise', async () => {
        const result = await postQuickAdd(
            makePayload(),
            fetchReturning(400, '{"errors":[{"field":"description"}]}')
        );
        expect(result.synced).toBe(false);
        expect(result.error).toContain('HTTP 400');
    });
});
