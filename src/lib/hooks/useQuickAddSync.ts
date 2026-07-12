'use client';

/**
 * useQuickAddSync
 *
 * Client hook that owns the quick-add offline queue lifecycle for a page:
 * - loads queued items on mount and syncs immediately when online
 * - listens for window 'online'/'offline' events and auto-syncs on reconnect
 * - exposes per-item retry/remove plus a manual "sync now"
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    getQuickAddQueue,
    QueuedQuickAdd,
    QuickAddQueue,
    SyncResult,
} from '@/lib/quick-add-queue';

export interface UseQuickAddSyncResult {
    /** All queued items (pending, syncing, failed), oldest first */
    items: QueuedQuickAdd[];
    /** Items awaiting sync (pending + syncing) */
    pendingCount: number;
    /** Items that failed their last sync attempt */
    failedCount: number;
    isSyncing: boolean;
    isOnline: boolean;
    /** Re-read the queue from storage */
    refresh: () => Promise<void>;
    /** Sync pending items now (also retries failed items) */
    sync: () => Promise<SyncResult | undefined>;
    /** Reset one failed item to pending and sync */
    retryItem: (localId: string) => Promise<void>;
    /** Delete one item from the queue without syncing it */
    removeItem: (localId: string) => Promise<void>;
}

export function useQuickAddSync(): UseQuickAddSyncResult {
    const [items, setItems] = useState<QueuedQuickAdd[]>([]);
    const [isSyncing, setIsSyncing] = useState(false);
    // Start optimistic to avoid a hydration mismatch; corrected in the mount effect.
    const [isOnline, setIsOnline] = useState(true);

    // Resolve the queue lazily (client-side only) so the SSR render pass
    // never touches IndexedDB.
    const queueRef = useRef<QuickAddQueue | null>(null);
    const getQueue = useCallback((): QuickAddQueue => {
        if (!queueRef.current) {
            queueRef.current = getQuickAddQueue();
        }
        return queueRef.current;
    }, []);

    const refresh = useCallback(async () => {
        setItems(await getQueue().listAll());
    }, [getQueue]);

    const syncingRef = useRef(false);
    const sync = useCallback(async (): Promise<SyncResult | undefined> => {
        if (syncingRef.current) return undefined;
        syncingRef.current = true;
        setIsSyncing(true);
        try {
            const result = await getQueue().syncAll(undefined, { includeFailed: true });
            await refresh();
            return result;
        } finally {
            syncingRef.current = false;
            setIsSyncing(false);
        }
    }, [getQueue, refresh]);

    const retryItem = useCallback(
        async (localId: string) => {
            await getQueue().retry(localId);
            await refresh();
            await sync();
        },
        [getQueue, refresh, sync]
    );

    const removeItem = useCallback(
        async (localId: string) => {
            await getQueue().remove(localId);
            await refresh();
        },
        [getQueue, refresh]
    );

    useEffect(() => {
        setIsOnline(navigator.onLine);
        void refresh();
        if (navigator.onLine) {
            void sync();
        }

        const handleOnline = () => {
            setIsOnline(true);
            void sync();
        };
        const handleOffline = () => setIsOnline(false);

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, [refresh, sync]);

    const pendingCount = items.filter(i => i.status === 'pending' || i.status === 'syncing').length;
    const failedCount = items.filter(i => i.status === 'failed').length;

    return {
        items,
        pendingCount,
        failedCount,
        isSyncing,
        isOnline,
        refresh,
        sync,
        retryItem,
        removeItem,
    };
}
