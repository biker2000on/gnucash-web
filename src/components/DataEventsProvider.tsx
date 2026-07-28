'use client';

/**
 * Data-change client bus.
 *
 * One EventSource to /api/data-events/stream per app instance relays
 * server-side data-change events for the active book (published by mutating
 * API routes via src/lib/data-events.ts). On each event burst it:
 *   (a) invalidates the matching React Query caches, and
 *   (b) re-dispatches a `gnucash:data-change` window CustomEvent so
 *       non-React-Query pages (AccountLedger, TransactionJournal, budgets,
 *       scheduled transactions) can refetch, matching the repo's CustomEvent
 *       bus convention (see JobProgressContext).
 *
 * Bursts are coalesced per entity (500ms) so a bulk operation emitting many
 * events triggers one refetch. Reconnects with exponential backoff when the
 * stream drops (same shape as JobProgressContext's SSE consumer).
 *
 * Mounted inside the authenticated shell (Layout.tsx) — renders nothing.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

export type DataChangeEntity =
  | 'transactions'
  | 'accounts'
  | 'budgets'
  | 'schedules'
  | 'reconciliation'
  | 'prices'
  | 'business'
  | 'book';

export interface DataChangeEventPayload {
  entity: DataChangeEntity;
  bookGuid: string;
  guid?: string;
  action?: 'create' | 'update' | 'delete' | 'bulk';
  ts: string;
}

/** Window event name pages subscribe to (detail: DataChangeEventPayload). */
export const DATA_CHANGE_EVENT = 'gnucash:data-change';

const DEBOUNCE_MS = 500;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

export function DataEventsProvider() {
  const queryClient = useQueryClient();
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(RECONNECT_MIN_MS);
  // Latest payload per entity, flushed together after the debounce window.
  const pendingRef = useRef(new Map<DataChangeEntity, DataChangeEventPayload>());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    flushTimerRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = new Map();

    for (const [entity, payload] of pending) {
      // React Query invalidation for the query keys each entity affects.
      if (entity === 'book') {
        // Import/overwrite/book delete: anything may have changed.
        void queryClient.invalidateQueries();
      } else if (entity === 'accounts') {
        void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      } else if (entity === 'transactions' || entity === 'reconciliation') {
        // Ledger writes move balances and reconcile/review rollups.
        void queryClient.invalidateQueries({ queryKey: ['accounts', 'balances'] });
        void queryClient.invalidateQueries({ queryKey: ['accounts', 'reconcile-summary'] });
        void queryClient.invalidateQueries({ queryKey: ['accounts', 'review-status'] });
      }
      // budgets / schedules / prices / business have no React Query caches
      // today — pages consume the window event below.

      window.dispatchEvent(new CustomEvent(DATA_CHANGE_EVENT, { detail: payload }));
    }
  }, [queryClient]);
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;

    let disposed = false;

    const connect = () => {
      if (disposed || sourceRef.current) return;
      const source = new EventSource('/api/data-events/stream');
      sourceRef.current = source;

      source.addEventListener('connected', () => {
        // Healthy stream — reset the backoff.
        reconnectDelayRef.current = RECONNECT_MIN_MS;
      });

      source.addEventListener('data-change', (e) => {
        try {
          const payload = JSON.parse((e as MessageEvent).data) as DataChangeEventPayload;
          if (!payload?.entity) return;
          pendingRef.current.set(payload.entity, payload);
          if (!flushTimerRef.current) {
            flushTimerRef.current = setTimeout(() => flushRef.current(), DEBOUNCE_MS);
          }
        } catch {
          // Malformed frame — ignore.
        }
      });

      source.onerror = () => {
        source.close();
        sourceRef.current = null;
        if (disposed) return;
        if (reconnectRef.current) clearTimeout(reconnectRef.current);
        const delay = reconnectDelayRef.current;
        reconnectDelayRef.current = Math.min(delay * 2, RECONNECT_MAX_MS);
        reconnectRef.current = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      sourceRef.current?.close();
      sourceRef.current = null;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, []);

  return null;
}
