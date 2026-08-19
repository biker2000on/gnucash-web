import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimerRegistry } from '../timer-registry';

describe('TimerRegistry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    describe('timer cancellation', () => {
        it('cancels registered timeouts and intervals on clearAllTimers', () => {
            const registry = new TimerRegistry();
            const onTimeout = vi.fn();
            const onInterval = vi.fn();

            registry.setTimeout(onTimeout, 1000);
            registry.setInterval(onInterval, 500);
            expect(registry.timerCount).toBe(2);

            registry.clearAllTimers();
            vi.advanceTimersByTime(5000);

            expect(onTimeout).not.toHaveBeenCalled();
            expect(onInterval).not.toHaveBeenCalled();
            expect(registry.timerCount).toBe(0);
        });

        it('latches closed so a self-rescheduling chain cannot rearm', () => {
            const registry = new TimerRegistry();
            const tick = vi.fn();

            // The worker's daily chains reschedule themselves from inside their
            // own callback. Without the latch, a callback that fires during
            // shutdown would arm a fresh timer after clearAllTimers ran.
            function scheduleNext() {
                registry.setTimeout(() => {
                    tick();
                    scheduleNext();
                }, 100);
            }
            scheduleNext();

            vi.advanceTimersByTime(250);
            expect(tick).toHaveBeenCalledTimes(2);

            registry.clearAllTimers();
            vi.advanceTimersByTime(10_000);
            expect(tick).toHaveBeenCalledTimes(2);
            expect(registry.setTimeout(tick, 1)).toBeNull();
            expect(registry.setInterval(tick, 1)).toBeNull();
            expect(registry.isStopped).toBe(true);
        });

        it('clear() removes a single handle from the registry', () => {
            const registry = new TimerRegistry();
            const a = vi.fn();
            const b = vi.fn();
            const handleA = registry.setTimeout(a, 100);
            registry.setTimeout(b, 100);

            registry.clear(handleA);
            expect(registry.timerCount).toBe(1);

            vi.advanceTimersByTime(200);
            expect(a).not.toHaveBeenCalled();
            expect(b).toHaveBeenCalledTimes(1);
            // A fired timeout deregisters itself.
            expect(registry.timerCount).toBe(0);
        });
    });

    describe('drain', () => {
        it('resolves immediately when nothing is in flight', async () => {
            const registry = new TimerRegistry();
            await expect(registry.drain(1000)).resolves.toEqual({ drained: true, pending: 0 });
        });

        it('waits for in-flight timer-driven work to finish', async () => {
            const registry = new TimerRegistry();
            let finished = false;
            let release!: () => void;
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });

            registry.run(async () => {
                await gate;
                finished = true;
            });
            expect(registry.inFlightCount).toBe(1);

            const drainPromise = registry.drain(60_000);
            // Not settled while the job is still running.
            expect(finished).toBe(false);

            release();
            const result = await drainPromise;

            expect(finished).toBe(true);
            expect(result).toEqual({ drained: true, pending: 0 });
            expect(registry.inFlightCount).toBe(0);
        });

        it('gives up after the bounded timeout rather than hanging shutdown', async () => {
            const registry = new TimerRegistry();
            // A job that never settles - the wedged-worker case.
            registry.run(() => new Promise<void>(() => {}));

            const drainPromise = registry.drain(5_000);
            await vi.advanceTimersByTimeAsync(5_000);
            const result = await drainPromise;

            expect(result.drained).toBe(false);
            expect(result.pending).toBe(1);
        });

        it('does not let a rejected job break the drain or escape as unhandled', async () => {
            const registry = new TimerRegistry();
            const onError = vi.fn();
            registry.run(async () => {
                throw new Error('scheduled job blew up');
            }, onError);

            const result = await registry.drain(1000);
            expect(result).toEqual({ drained: true, pending: 0 });
            expect(onError).toHaveBeenCalledTimes(1);
        });

        it('drains work started by a timer that already fired', async () => {
            const registry = new TimerRegistry();
            let ran = false;
            let release!: () => void;
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });

            registry.setInterval(() => {
                registry.run(async () => {
                    await gate;
                    ran = true;
                });
            }, 100);

            vi.advanceTimersByTime(100);
            expect(registry.inFlightCount).toBe(1);

            // Shutdown order: stop the timers, then drain what already started.
            registry.clearAllTimers();
            const drainPromise = registry.drain(60_000);
            release();
            await drainPromise;

            expect(ran).toBe(true);
            expect(registry.inFlightCount).toBe(0);
        });
    });

    describe('track', () => {
        it('returns the caller\'s promise unchanged', async () => {
            const registry = new TimerRegistry();
            const promise = Promise.resolve(42);
            await expect(registry.track(promise)).resolves.toBe(42);
        });

        it('propagates rejections to the caller', async () => {
            const registry = new TimerRegistry();
            await expect(registry.track(Promise.reject(new Error('boom')))).rejects.toThrow('boom');
        });
    });
});
