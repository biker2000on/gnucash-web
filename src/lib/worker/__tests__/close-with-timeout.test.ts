import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWithTimeout, type ClosableWorker } from '../close-with-timeout';

describe('closeWithTimeout', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns closed when the graceful close finishes in time', async () => {
        const worker: ClosableWorker = { close: vi.fn().mockResolvedValue(undefined) };
        await expect(closeWithTimeout(worker, 10_000)).resolves.toBe('closed');
        expect(worker.close).toHaveBeenCalledTimes(1);
        expect(worker.close).toHaveBeenCalledWith();
    });

    it('treats a rejected close as finished', async () => {
        const worker: ClosableWorker = { close: vi.fn().mockRejectedValue(new Error('connection closed')) };
        await expect(closeWithTimeout(worker, 10_000)).resolves.toBe('closed');
    });

    it('forces a close and returns when the graceful close hangs (redis gone)', async () => {
        const close = vi.fn((force?: boolean) =>
            // The graceful close never settles; the forced one hangs too.
            force ? new Promise<void>(() => {}) : new Promise<void>(() => {}),
        );
        const result = closeWithTimeout({ close }, 10_000);
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(result).resolves.toBe('forced');
        expect(close).toHaveBeenNthCalledWith(1);
        expect(close).toHaveBeenNthCalledWith(2, true);
    });

    it('does not fire the forced close before the deadline', async () => {
        const close = vi.fn(() => new Promise<void>(() => {}));
        void closeWithTimeout({ close }, 10_000);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(close).toHaveBeenCalledTimes(1);
    });
});
