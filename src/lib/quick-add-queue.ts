/**
 * Quick-Add Offline Queue
 *
 * IndexedDB-backed queue (raw IndexedDB, no dependencies) for quick-add
 * transactions captured while offline or when a POST to /api/transactions
 * fails. Each queued item carries a full CreateTransactionRequest with a
 * client-generated GUID, so syncing is idempotent: if the same payload is
 * posted twice, the server rejects the duplicate GUID and we treat that as
 * "already synced" and drop the item.
 *
 * The queue core is written against a small QueueStorage interface so the
 * sync loop and payload building are unit-testable without a real IndexedDB
 * (see createInMemoryStorage). Production code uses createIndexedDbStorage.
 */

import type { CreateTransactionRequest } from '@/lib/types';
import { generateGuid } from '@/lib/guid';
import { toNumDenom } from '@/lib/validation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuickAddStatus = 'pending' | 'syncing' | 'failed';

export interface QueuedQuickAdd {
    /** Local queue key (not the transaction GUID) */
    localId: string;
    /** ISO timestamp of when the item was queued */
    createdAt: string;
    /** Full request body, including a client-generated transaction GUID */
    payload: CreateTransactionRequest;
    status: QuickAddStatus;
    /** Last sync error message (when status === 'failed') */
    error?: string;
}

/** Minimal async key-value storage the queue runs on. */
export interface QueueStorage {
    get(localId: string): Promise<QueuedQuickAdd | undefined>;
    getAll(): Promise<QueuedQuickAdd[]>;
    put(item: QueuedQuickAdd): Promise<void>;
    delete(localId: string): Promise<void>;
}

export interface SyncResult {
    /** Items successfully posted (or confirmed already-synced via duplicate GUID) */
    synced: number;
    /** Items that failed and were marked 'failed' */
    failed: number;
    /** Items still in the queue after the run (pending + failed) */
    remaining: number;
}

export interface SyncOptions {
    /** Also retry items currently marked 'failed' (default: false) */
    includeFailed?: boolean;
}

export interface QuickAddQueue {
    enqueue(payload: CreateTransactionRequest): Promise<QueuedQuickAdd>;
    listPending(): Promise<QueuedQuickAdd[]>;
    /** All items regardless of status, oldest first */
    listAll(): Promise<QueuedQuickAdd[]>;
    markSyncing(localId: string): Promise<void>;
    markFailed(localId: string, error: string): Promise<void>;
    /** Reset a failed/stuck item back to 'pending' so syncAll picks it up */
    retry(localId: string): Promise<void>;
    remove(localId: string): Promise<void>;
    /**
     * Posts each pending item to /api/transactions. Removes items on success
     * or on duplicate-GUID responses (409 / "already exists"); marks items
     * failed otherwise. Safe to call concurrently: a second call while a run
     * is in flight returns the in-flight run's promise.
     */
    syncAll(fetchImpl?: typeof fetch, options?: SyncOptions): Promise<SyncResult>;
}

// ---------------------------------------------------------------------------
// Payload building
// ---------------------------------------------------------------------------

export type QuickAddKind = 'expense' | 'income';

export interface QuickAddInput {
    kind: QuickAddKind;
    /** Positive decimal amount */
    amount: number;
    /** The asset/bank/cash/credit account the money moves through ("from") */
    accountGuid: string;
    /** The expense or income category account ("to") */
    categoryGuid: string;
    currencyGuid: string;
    description?: string;
    /** YYYY-MM-DD; defaults to today (local) */
    postDate?: string;
}

function todayLocal(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Build a balanced 2-split transaction request for a quick-add entry.
 *
 * Expense: asset account is credited (negative), expense category debited (positive).
 * Income:  asset account is debited (positive), income category credited (negative).
 * Both splits use the same denomination, so they always sum to exactly zero.
 */
export function buildQuickAddTransaction(input: QuickAddInput): CreateTransactionRequest {
    if (!(input.amount > 0)) {
        throw new Error('Quick-add amount must be greater than zero');
    }
    if (input.accountGuid === input.categoryGuid) {
        throw new Error('Account and category must be different');
    }

    const { num, denom } = toNumDenom(input.amount);
    // Sign of the asset-account split: money leaves it for an expense,
    // arrives into it for income.
    const assetSign = input.kind === 'expense' ? -1 : 1;
    const assetNum = assetSign * num;
    const categoryNum = -assetSign * num;

    return {
        guid: generateGuid(),
        currency_guid: input.currencyGuid,
        post_date: input.postDate || todayLocal(),
        description: input.description?.trim() || 'Quick add',
        splits: [
            {
                guid: generateGuid(),
                account_guid: input.accountGuid,
                value_num: assetNum,
                value_denom: denom,
                quantity_num: assetNum,
                quantity_denom: denom,
                reconcile_state: 'n',
            },
            {
                guid: generateGuid(),
                account_guid: input.categoryGuid,
                value_num: categoryNum,
                value_denom: denom,
                quantity_num: categoryNum,
                quantity_denom: denom,
                reconcile_state: 'n',
            },
        ],
    };
}

// ---------------------------------------------------------------------------
// Posting + response classification
// ---------------------------------------------------------------------------

const ALREADY_SYNCED_RE = /duplicate|already exists|unique constraint/i;

export interface PostResult {
    /** True when the transaction is on the server (created now or previously) */
    synced: boolean;
    /** Populated when synced === false */
    error?: string;
}

/**
 * POST a quick-add payload to /api/transactions and classify the outcome.
 * 2xx and 409 (or a duplicate-GUID error body) count as synced — the client
 * GUID makes re-posting the same transaction idempotent.
 */
export async function postQuickAdd(
    payload: CreateTransactionRequest,
    fetchImpl: typeof fetch = globalThis.fetch
): Promise<PostResult> {
    let res: Response;
    try {
        res = await fetchImpl('/api/transactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    } catch (err) {
        return { synced: false, error: err instanceof Error ? err.message : 'Network error' };
    }

    if (res.ok || res.status === 409) {
        return { synced: true };
    }

    let body = '';
    try {
        body = await res.text();
    } catch {
        // Ignore unreadable bodies; classify on status alone.
    }
    if (ALREADY_SYNCED_RE.test(body)) {
        return { synced: true };
    }

    const detail = body ? `: ${body.slice(0, 200)}` : '';
    return { synced: false, error: `HTTP ${res.status}${detail}` };
}

// ---------------------------------------------------------------------------
// Queue core (storage-agnostic)
// ---------------------------------------------------------------------------

export function createQuickAddQueue(storage: QueueStorage): QuickAddQueue {
    // In-flight guard: prevents the same tab from running two overlapping
    // sync loops (e.g. 'online' event firing during a mount-time sync).
    let inFlight: Promise<SyncResult> | null = null;

    const listAll = async (): Promise<QueuedQuickAdd[]> => {
        const items = await storage.getAll();
        return items.sort((a, b) =>
            a.createdAt === b.createdAt
                ? a.localId.localeCompare(b.localId)
                : a.createdAt.localeCompare(b.createdAt)
        );
    };

    const setStatus = async (localId: string, status: QuickAddStatus, error?: string) => {
        const item = await storage.get(localId);
        if (!item) return;
        const next: QueuedQuickAdd = { ...item, status };
        if (error !== undefined) {
            next.error = error;
        } else {
            delete next.error;
        }
        await storage.put(next);
    };

    const runSync = async (fetchImpl: typeof fetch, options?: SyncOptions): Promise<SyncResult> => {
        const statuses: QuickAddStatus[] = options?.includeFailed
            ? ['pending', 'failed']
            : ['pending'];
        const candidates = (await listAll()).filter(item => statuses.includes(item.status));

        let synced = 0;
        let failed = 0;

        for (const candidate of candidates) {
            // Re-read: the item may have been removed or picked up elsewhere
            // (another tab) since we listed it.
            const current = await storage.get(candidate.localId);
            if (!current || current.status === 'syncing') continue;

            await setStatus(current.localId, 'syncing');
            const result = await postQuickAdd(current.payload, fetchImpl);

            if (result.synced) {
                await storage.delete(current.localId);
                synced++;
            } else {
                await setStatus(current.localId, 'failed', result.error ?? 'Sync failed');
                failed++;
            }
        }

        const remaining = (await listAll()).length;
        return { synced, failed, remaining };
    };

    return {
        async enqueue(payload) {
            const item: QueuedQuickAdd = {
                localId: generateGuid(),
                createdAt: new Date().toISOString(),
                payload,
                status: 'pending',
            };
            await storage.put(item);
            return item;
        },

        async listPending() {
            return (await listAll()).filter(item => item.status === 'pending');
        },

        listAll,

        markSyncing: (localId) => setStatus(localId, 'syncing'),

        markFailed: (localId, error) => setStatus(localId, 'failed', error),

        retry: (localId) => setStatus(localId, 'pending'),

        remove: (localId) => storage.delete(localId),

        syncAll(fetchImpl = globalThis.fetch, options?) {
            if (inFlight) return inFlight;
            inFlight = runSync(fetchImpl, options).finally(() => {
                inFlight = null;
            });
            return inFlight;
        },
    };
}

// ---------------------------------------------------------------------------
// Storage backends
// ---------------------------------------------------------------------------

/** In-memory storage — used in tests and as an SSR/no-IndexedDB fallback. */
export function createInMemoryStorage(): QueueStorage {
    const store = new Map<string, QueuedQuickAdd>();
    return {
        async get(localId) {
            const item = store.get(localId);
            return item ? { ...item } : undefined;
        },
        async getAll() {
            return Array.from(store.values()).map(item => ({ ...item }));
        },
        async put(item) {
            store.set(item.localId, { ...item });
        },
        async delete(localId) {
            store.delete(localId);
        },
    };
}

const DB_NAME = 'gnucash-web-quick-add';
const DB_VERSION = 1;
const STORE_NAME = 'queue';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
}

/** Raw-IndexedDB storage backend (browser only). */
export function createIndexedDbStorage(dbName: string = DB_NAME): QueueStorage {
    let dbPromise: Promise<IDBDatabase> | null = null;

    const openDb = (): Promise<IDBDatabase> => {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(dbName, DB_VERSION);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME, { keyPath: 'localId' });
                    }
                };
                request.onsuccess = () => {
                    const db = request.result;
                    // If the connection dies (e.g. devtools "clear storage"),
                    // reopen lazily on the next operation.
                    db.onclose = () => {
                        dbPromise = null;
                    };
                    resolve(db);
                };
                request.onerror = () => {
                    dbPromise = null;
                    reject(request.error ?? new Error('Failed to open quick-add queue database'));
                };
            });
        }
        return dbPromise;
    };

    const withStore = async <T>(
        mode: IDBTransactionMode,
        operation: (store: IDBObjectStore) => IDBRequest<T>
    ): Promise<T> => {
        const db = await openDb();
        const tx = db.transaction(STORE_NAME, mode);
        return requestToPromise(operation(tx.objectStore(STORE_NAME)));
    };

    return {
        get: (localId) =>
            withStore('readonly', store => store.get(localId)) as Promise<QueuedQuickAdd | undefined>,
        getAll: () =>
            withStore('readonly', store => store.getAll()) as Promise<QueuedQuickAdd[]>,
        async put(item) {
            await withStore('readwrite', store => store.put(item));
        },
        async delete(localId) {
            await withStore('readwrite', store => store.delete(localId));
        },
    };
}

// ---------------------------------------------------------------------------
// Default singleton
// ---------------------------------------------------------------------------

let defaultQueue: QuickAddQueue | null = null;

/**
 * The app-wide quick-add queue. Uses IndexedDB in the browser; falls back to
 * an in-memory store where IndexedDB is unavailable (SSR render pass, very
 * old browsers) so callers never crash — persistence just degrades.
 */
export function getQuickAddQueue(): QuickAddQueue {
    if (!defaultQueue) {
        const storage =
            typeof indexedDB !== 'undefined' ? createIndexedDbStorage() : createInMemoryStorage();
        defaultQueue = createQuickAddQueue(storage);
    }
    return defaultQueue;
}
