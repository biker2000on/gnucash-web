/**
 * DataEventsProvider tests: SSE relay -> React Query invalidation + window
 * CustomEvent fan-out, with visibility gating (hidden tabs accumulate and
 * flush once on visible) and per-tab self-echo suppression.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
    DataEventsProvider,
    DATA_CHANGE_EVENT,
    SUPPRESS_ECHO_MS,
    clearEchoSuppression,
    suppressNextDataEvent,
    type DataChangeEntity,
    type DataChangeEventPayload,
} from '../DataEventsProvider';

// ---------------------------------------------------------------------------
// EventSource mock (jsdom has none)
// ---------------------------------------------------------------------------

type Listener = (e: MessageEvent) => void;

class MockEventSource {
    static instances: MockEventSource[] = [];
    url: string;
    onerror: ((e?: unknown) => void) | null = null;
    private listeners = new Map<string, Set<Listener>>();

    constructor(url: string) {
        this.url = url;
        MockEventSource.instances.push(this);
    }

    addEventListener(type: string, cb: Listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(cb);
    }

    removeEventListener(type: string, cb: Listener) {
        this.listeners.get(type)?.delete(cb);
    }

    close() {}

    emit(type: string, data?: unknown) {
        for (const cb of this.listeners.get(type) ?? new Set<Listener>()) {
            cb({ data: JSON.stringify(data) } as MessageEvent);
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 500;

let visibility: DocumentVisibilityState = 'visible';
let queryClient: QueryClient;
let invalidateSpy: ReturnType<typeof vi.spyOn>;
let receivedEvents: DataChangeEventPayload[] = [];

function onWindowDataChange(e: Event) {
    receivedEvents.push((e as CustomEvent).detail as DataChangeEventPayload);
}

function renderProvider() {
    return render(
        <QueryClientProvider client={queryClient}>
            <DataEventsProvider />
        </QueryClientProvider>,
    );
}

function source(): MockEventSource {
    const instance = MockEventSource.instances.at(-1);
    if (!instance) throw new Error('EventSource was never constructed');
    return instance;
}

function emitDataChange(entity: DataChangeEntity, extra: Partial<DataChangeEventPayload> = {}) {
    source().emit('data-change', {
        entity,
        bookGuid: 'book-1',
        ts: new Date().toISOString(),
        ...extra,
    });
}

function setVisibility(next: DocumentVisibilityState) {
    visibility = next;
    document.dispatchEvent(new Event('visibilitychange'));
}

/** Query keys passed to invalidateQueries so far ('UNFILTERED' marks a bare call). */
function invalidatedKeys(): unknown[] {
    return (invalidateSpy.mock.calls as unknown[][]).map((call: unknown[]) => {
        const filters = call[0] as { queryKey?: unknown } | undefined;
        return filters?.queryKey ?? 'UNFILTERED';
    });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibility,
    });
    visibility = 'visible';
    queryClient = new QueryClient();
    invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    receivedEvents = [];
    window.addEventListener(DATA_CHANGE_EVENT, onWindowDataChange);
});

afterEach(() => {
    window.removeEventListener(DATA_CHANGE_EVENT, onWindowDataChange);
    cleanup();
    // The suppression map is module-level; clear it so a test's echo window
    // cannot bleed into the next test.
    clearEchoSuppression();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DataEventsProvider', () => {
    it('relays a transactions event after the debounce window', () => {
        renderProvider();
        emitDataChange('transactions', { guid: 'tx-1', action: 'update' });

        expect(receivedEvents).toHaveLength(0);
        vi.advanceTimersByTime(DEBOUNCE_MS);

        expect(receivedEvents).toHaveLength(1);
        expect(receivedEvents[0].entity).toBe('transactions');
        expect(invalidatedKeys()).toEqual([
            ['accounts', 'balances'],
            ['accounts', 'reconcile-summary'],
            ['accounts', 'review-status'],
        ]);
    });

    it('coalesces a burst per entity into one flush', () => {
        renderProvider();
        emitDataChange('transactions', { guid: 'tx-1' });
        emitDataChange('transactions', { guid: 'tx-2' });
        emitDataChange('transactions', { guid: 'tx-3' });
        vi.advanceTimersByTime(DEBOUNCE_MS);

        expect(receivedEvents).toHaveLength(1);
        expect(receivedEvents[0].guid).toBe('tx-3');
    });

    it('narrows accounts events to hierarchy + balances keys', () => {
        renderProvider();
        emitDataChange('accounts', { guid: 'acc-1', action: 'update' });
        vi.advanceTimersByTime(DEBOUNCE_MS);

        expect(invalidatedKeys()).toEqual([
            ['accounts', 'hierarchy'],
            ['accounts', 'balances'],
        ]);
    });

    it('scopes book events to a known-key list instead of invalidating everything', () => {
        renderProvider();
        emitDataChange('book', { action: 'bulk' });
        vi.advanceTimersByTime(DEBOUNCE_MS);

        const keys = invalidatedKeys();
        expect(keys).not.toContain('UNFILTERED');
        expect(keys).toEqual([
            ['accounts', 'hierarchy'],
            ['accounts', 'balances'],
            ['accounts', 'reconcile-summary'],
            ['accounts', 'review-status'],
            ['tags'],
        ]);
    });

    it('does not refetch while hidden and flushes the union once on visible', () => {
        renderProvider();
        visibility = 'hidden';

        emitDataChange('transactions', { guid: 'tx-1' });
        emitDataChange('budgets', { guid: 'budget-1' });
        vi.advanceTimersByTime(DEBOUNCE_MS * 10);

        expect(receivedEvents).toHaveLength(0);
        expect(invalidateSpy).not.toHaveBeenCalled();

        setVisibility('visible');

        expect(receivedEvents.map(e => e.entity).sort()).toEqual(['budgets', 'transactions']);
        expect(invalidatedKeys()).toContainEqual(['accounts', 'balances']);
    });

    it('holds events accumulated before a scheduled flush fires while hidden', () => {
        renderProvider();
        emitDataChange('transactions', { guid: 'tx-1' });
        // Tab hides after the debounce timer was scheduled but before it fired.
        visibility = 'hidden';
        vi.advanceTimersByTime(DEBOUNCE_MS);

        expect(receivedEvents).toHaveLength(0);

        setVisibility('visible');
        expect(receivedEvents).toHaveLength(1);
        expect(receivedEvents[0].entity).toBe('transactions');
    });

    it('drops this tab\'s own echo after suppressNextDataEvent, then resumes', () => {
        renderProvider();

        suppressNextDataEvent('transactions');
        emitDataChange('transactions', { guid: 'tx-own' });
        vi.advanceTimersByTime(DEBOUNCE_MS);

        expect(receivedEvents).toHaveLength(0);
        expect(invalidateSpy).not.toHaveBeenCalled();

        // After the suppression window expires, events flow again.
        vi.advanceTimersByTime(SUPPRESS_ECHO_MS);
        emitDataChange('transactions', { guid: 'tx-remote' });
        vi.advanceTimersByTime(DEBOUNCE_MS);

        expect(receivedEvents).toHaveLength(1);
        expect(receivedEvents[0].guid).toBe('tx-remote');
    });

    it('suppression is per entity', () => {
        renderProvider();

        suppressNextDataEvent('transactions');
        emitDataChange('transactions', { guid: 'tx-own' });
        emitDataChange('schedules', { guid: 'sched-remote' });
        vi.advanceTimersByTime(DEBOUNCE_MS);

        expect(receivedEvents.map(e => e.entity)).toEqual(['schedules']);
    });

    it('drops a late echo when suppression is marked after the frame arrived', () => {
        renderProvider();

        // SSE frame beats the mutating fetch's response...
        emitDataChange('transactions', { guid: 'tx-own' });
        // ...then the page's success handler marks suppression before the flush.
        vi.advanceTimersByTime(DEBOUNCE_MS / 2);
        suppressNextDataEvent('transactions');
        vi.advanceTimersByTime(DEBOUNCE_MS);

        expect(receivedEvents).toHaveLength(0);
    });
});
