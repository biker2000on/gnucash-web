/**
 * Next.js instrumentation hook — runs once per server process start.
 *
 * Starts the server-side data-change subscriber so Redis `data-change:book:*`
 * events invalidate the book-scope TTL cache and Redis dashboard caches in
 * the web process (the worker starts the same subscriber in worker.ts).
 */
export async function register(): Promise<void> {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { startDataEventsSubscriber } = await import('./lib/data-events-subscriber');
        startDataEventsSubscriber();
    }
}
