import { Pool, PoolConfig } from 'pg';

const poolConfig: PoolConfig = {
    // GnuCash DB connection details are handled by the MCP server,
    // but for the app we need standard env vars.
    connectionString: process.env.DATABASE_URL,
    // Explicit cap so heavy interactive transactions (imports, lot scrubs)
    // can't silently exhaust Postgres connections across the two pools
    // (this raw pg pool + Prisma's adapter pool in prisma.ts).
    max: Number.parseInt(process.env.DB_POOL_MAX ?? '', 10) || 20,
};

const pool = new Pool(poolConfig);

// pg emits 'error' on IDLE pooled clients (Postgres restart/upgrade, OOM kill,
// container cycle, network drop). Node treats an unhandled 'error' event on an
// EventEmitter as an uncaught exception, which would take the whole Next.js
// server down. Log it instead: pg discards the broken client and the next
// checkout opens a fresh connection.
pool.on('error', (err) => {
    console.error('Postgres pool (db.ts) idle client error:', err);
});

export const query = (text: string, params?: readonly unknown[]) =>
    params ? pool.query(text, [...params]) : pool.query(text);

/**
 * Runs an operation while holding a PostgreSQL session-level advisory lock.
 *
 * The lock connection stays checked out for the full operation, even when the
 * operation itself uses the shared pool. This lets independent app processes
 * serialize work such as schema initialization without a separate lock table.
 */
export async function withDatabaseAdvisoryLock<T>(
    lockName: string,
    operation: () => Promise<T>,
): Promise<T> {
    const client = await pool.connect();
    let lockAcquired = false;
    let operationError: unknown;

    try {
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
        lockAcquired = true;
        return await operation();
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        let unlockError: unknown;

        try {
            if (lockAcquired) {
                await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
            }
        } catch (error) {
            unlockError = error;
        } finally {
            // A connection whose lock could not be released must not return to
            // the pool, or a later borrower could inherit the advisory lock.
            client.release(Boolean(unlockError));
        }

        if (unlockError) {
            if (operationError) {
                throw new AggregateError(
                    [operationError, unlockError],
                    `Operation and advisory-lock release both failed for "${lockName}"`,
                );
            }
            throw unlockError;
        }
    }
}

/**
 * Non-blocking variant of {@link withDatabaseAdvisoryLock}: attempts the
 * session-level advisory lock without waiting. When another process/session
 * already holds it, returns `{ acquired: false }` immediately so the caller
 * can surface a "operation already in progress" error instead of queueing.
 */
export async function tryWithDatabaseAdvisoryLock<T>(
    lockName: string,
    operation: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; result: T }> {
    const client = await pool.connect();
    let lockAcquired = false;
    let operationError: unknown;

    try {
        const res = await client.query(
            'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
            [lockName],
        );
        lockAcquired = res.rows?.[0]?.locked === true;
        if (!lockAcquired) {
            return { acquired: false };
        }
        return { acquired: true, result: await operation() };
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        let unlockError: unknown;

        try {
            if (lockAcquired) {
                await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
            }
        } catch (error) {
            unlockError = error;
        } finally {
            // A connection whose lock could not be released must not return to
            // the pool, or a later borrower could inherit the advisory lock.
            client.release(Boolean(unlockError));
        }

        if (unlockError) {
            if (operationError) {
                throw new AggregateError(
                    [operationError, unlockError],
                    `Operation and advisory-lock release both failed for "${lockName}"`,
                );
            }
            throw unlockError;
        }
    }
}

// NOTE: the GnuCash fraction -> decimal helper lives in `src/lib/gnucash.ts`
// (`toDecimal`). A byte-for-byte duplicate used to live here with no importers;
// it was removed so there is a single implementation.
