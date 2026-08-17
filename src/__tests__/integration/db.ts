/**
 * Connection helper for the integration tier.
 *
 * Tests that only need to run app code can ignore this: the setup file points
 * DATABASE_URL at the test database, so src/lib/db.ts connects there on its
 * own. This pool is for the other half of the job - holding a SECOND, separate
 * connection so a test can observe what the app's connection is doing. Lock
 * ordering, FOR UPDATE, and advisory-lock behaviour are only visible from
 * outside the transaction under test, which is precisely what a mocked pool
 * can never provide.
 */
import { Pool, type PoolClient } from 'pg';
import { requireTestDatabaseUrl } from './env';

let pool: Pool | null = null;

/** Lazily opens the shared test pool. Small on purpose - see closeTestPool. */
export function getTestPool(): Pool {
    if (!pool) {
        pool = new Pool({ connectionString: requireTestDatabaseUrl(), max: 8 });
        // pg raises 'error' on idle clients; an unhandled one is an uncaught
        // exception that would kill the vitest worker with an unrelated stack.
        pool.on('error', (err) => {
            console.error('Integration test pool idle client error:', err);
        });
    }
    return pool;
}

/** Checks out a dedicated client and always releases it. */
export async function withTestClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await getTestPool().connect();
    try {
        return await fn(client);
    } finally {
        client.release();
    }
}

/**
 * Closes the pool. Registered as an afterAll by the integration setup file, so
 * individual tests do not need to call it; without it the vitest worker hangs
 * on open sockets after the last assertion.
 */
export async function closeTestPool(): Promise<void> {
    if (!pool) return;
    const closing = pool;
    pool = null;
    await closing.end();
}
