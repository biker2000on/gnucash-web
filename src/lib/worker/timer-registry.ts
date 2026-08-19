/**
 * Timer + in-flight job registry for the background worker.
 *
 * The worker arms a lot of timers: per-book daily price refreshes, per-connection
 * SimpleFin intervals, a dozen `setScheduleGeneric` daily chains, and two bare
 * `setInterval`s (email ingest, funding sweep). Shutdown used to clear only the
 * per-book price-refresh timers, so on SIGTERM the process called
 * `process.exit(0)` while SimpleFin intervals were still armed and while
 * timer-driven work (a SimpleFin sync mid-import, a backup run) was still in
 * flight. `process.exit` does not wait for anything: the job was killed at an
 * arbitrary await point.
 *
 * This registry owns every timer the worker creates and every promise a timer
 * callback produces, so shutdown can (a) stop new work from being armed and
 * (b) wait — with a bound — for work already running to finish.
 *
 * It is deliberately dependency-free and side-effect-free at import time so it
 * can be unit-tested with fake timers.
 */

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface DrainResult {
    /** True when every tracked promise settled before the deadline. */
    drained: boolean;
    /** Number of promises still outstanding when drain() returned. */
    pending: number;
}

/** The default {@link TimerRegistry.run} error reporter. */
function logTimerJobError(err: unknown): void {
    console.error('[worker] unhandled timer job error', err);
}

export class TimerRegistry {
    private readonly timeouts = new Set<TimerHandle>();
    private readonly intervals = new Set<TimerHandle>();
    private readonly inFlight = new Set<Promise<unknown>>();
    private stopped = false;

    /** True once {@link clearAllTimers} has run; callers use it to stop rearming. */
    get isStopped(): boolean {
        return this.stopped;
    }

    get timerCount(): number {
        return this.timeouts.size + this.intervals.size;
    }

    get inFlightCount(): number {
        return this.inFlight.size;
    }

    /**
     * `setTimeout` that is registered for shutdown. After {@link clearAllTimers}
     * nothing new is armed — a recurring chain that reschedules itself from its
     * own callback therefore stops instead of resurrecting itself.
     */
    setTimeout(fn: () => void, ms: number): TimerHandle | null {
        if (this.stopped) return null;
        const handle: TimerHandle = setTimeout(() => {
            this.timeouts.delete(handle);
            fn();
        }, ms);
        this.timeouts.add(handle);
        return handle;
    }

    /** `setInterval` that is registered for shutdown. */
    setInterval(fn: () => void, ms: number): TimerHandle | null {
        if (this.stopped) return null;
        const handle: TimerHandle = setInterval(fn, ms);
        this.intervals.add(handle);
        return handle;
    }

    /** Cancel one handle previously returned by this registry. */
    clear(handle: TimerHandle | null | undefined): void {
        if (!handle) return;
        if (this.timeouts.delete(handle)) {
            clearTimeout(handle);
            return;
        }
        if (this.intervals.delete(handle)) {
            clearInterval(handle);
        }
    }

    /**
     * Cancel every armed timer and latch the registry closed so later
     * `setTimeout`/`setInterval` calls (from an already-running callback that
     * reschedules itself) become no-ops.
     */
    clearAllTimers(): void {
        this.stopped = true;
        for (const handle of this.timeouts) clearTimeout(handle);
        for (const handle of this.intervals) clearInterval(handle);
        this.timeouts.clear();
        this.intervals.clear();
    }

    /**
     * Track a promise as in-flight work. Returns the same promise so callers
     * keep their own error handling; rejections are swallowed for the internal
     * copy only, so tracking never creates an unhandled rejection.
     */
    track<T>(promise: Promise<T>): Promise<T> {
        const settled = promise.then(
            () => undefined,
            () => undefined,
        );
        this.inFlight.add(settled);
        void settled.finally(() => {
            this.inFlight.delete(settled);
        });
        return promise;
    }

    /**
     * Fire-and-forget helper for timer callbacks: run `fn()` and track it.
     * Errors are reported through `onError` rather than escaping to the
     * process-level unhandledRejection handler.
     *
     * `onError` DEFAULTS to logging rather than being optional-and-silent. An
     * omitted handler used to mean the failure vanished: `track` already
     * swallows the rejection to avoid an unhandled-rejection crash, so a timer
     * job that threw left no trace anywhere. A background job failing quietly
     * every night is the worst possible failure mode for this process — the
     * default makes forgetting the handler loud instead of invisible.
     */
    run(fn: () => Promise<unknown>, onError: (err: unknown) => void = logTimerJobError): void {
        let promise: Promise<unknown>;
        try {
            promise = Promise.resolve(fn());
        } catch (err) {
            onError(err);
            return;
        }
        void this.track(promise).catch(err => onError(err));
    }

    /**
     * Wait for tracked work to settle, giving up after `timeoutMs`.
     *
     * Bounded on purpose: the container's `stop_grace_period` is the real
     * deadline, and a wedged job must not stop the worker from exiting before
     * Docker escalates to SIGKILL (which would abort every other job too).
     */
    async drain(timeoutMs: number): Promise<DrainResult> {
        if (this.inFlight.size === 0) return { drained: true, pending: 0 };

        const all = Promise.allSettled(Array.from(this.inFlight)).then(() => 'done' as const);

        let deadline: TimerHandle | undefined;
        const timeout = new Promise<'timeout'>(resolve => {
            deadline = setTimeout(() => resolve('timeout'), timeoutMs);
            // Never let the deadline itself hold the event loop open.
            (deadline as unknown as { unref?: () => void }).unref?.();
        });

        try {
            const outcome = await Promise.race([all, timeout]);
            return { drained: outcome === 'done', pending: this.inFlight.size };
        } finally {
            if (deadline) clearTimeout(deadline);
        }
    }
}
