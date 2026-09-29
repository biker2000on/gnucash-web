/**
 * Bounded shutdown for the BullMQ worker.
 *
 * `Worker.close()` waits for active jobs and then closes its Redis
 * connections. If Redis is already gone it never resolves: ioredis keeps
 * retrying the lookup (`ENOTFOUND redis`) and the promise hangs. That is the
 * normal state during a production deploy, because Dockhand's force-recreate
 * replaces redis before it stops the old worker. The worker then sat out the
 * whole 5-minute `stop_grace_period` and was SIGKILLed, which held every
 * deploy for 5 minutes (reproduced on the dev stack 2026-09-29: stopping
 * redis first made the worker exit 137 at the timeout).
 *
 * This waits for a graceful close up to `timeoutMs`, then asks for a forced
 * close (which does not wait for active jobs) without awaiting it, so the
 * caller can move on to draining timer-driven work and exiting.
 */

export interface ClosableWorker {
    close(force?: boolean): Promise<void>;
}

export type CloseOutcome = 'closed' | 'forced';

export async function closeWithTimeout(worker: ClosableWorker, timeoutMs: number): Promise<CloseOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const graceful = worker.close().then(
        () => 'closed' as const,
        // A close that rejects is as finished as one that resolves; the
        // process is exiting either way.
        () => 'closed' as const,
    );

    const result = await Promise.race([graceful, timedOut]);
    clearTimeout(timer);
    if (result === 'closed') return 'closed';

    // Fire and forget: a forced close can hang on the same dead connection.
    worker.close(true).catch(() => {});
    return 'forced';
}
