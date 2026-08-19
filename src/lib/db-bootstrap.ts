import fs from 'node:fs';
import path from 'node:path';

/**
 * Fresh-install schema bootstrap.
 *
 * Extracted from `scripts/db-init-entrypoint.ts` so the concurrency behaviour
 * is unit-testable without a database: the entrypoint is a thin wrapper that
 * supplies the real `query` and `withDatabaseAdvisoryLock`.
 */

export interface BootstrapQueryResult {
    rowCount: number | null;
}

export type BootstrapQuery = (text: string) => Promise<BootstrapQueryResult>;

export type BootstrapLock = <T>(lockName: string, operation: () => Promise<T>) => Promise<T>;

/**
 * Deliberately the SAME lock `initializeDatabase()` takes. Bootstrap and the
 * idempotent DDL sync are two halves of one schema migration, and they must
 * serialize against each other as well as against themselves — otherwise the
 * app container can run `CREATE TABLE ... IF NOT EXISTS` against tables the
 * worker's bootstrap.sql is still in the middle of creating.
 */
export const SCHEMA_BOOTSTRAP_LOCK = 'gnucash-web:database-initialization';

export type BootstrapOutcome =
    /** A `books` table already existed before we took the lock. */
    | 'existing'
    /** Empty before the lock, but another container bootstrapped while we waited. */
    | 'existing-after-lock'
    /** Empty database, bootstrap.sql applied by us. */
    | 'bootstrapped'
    /** Empty database but no bootstrap.sql shipped; db-init has to do it all. */
    | 'missing-sql';

export interface BootstrapOptions {
    /** Override for tests; defaults to `<cwd>/bootstrap.sql`. */
    sqlPath?: string;
    /** Override for tests; returns null when the file is absent. */
    readBootstrapSql?: (sqlPath: string) => string | null;
    log?: (message: string) => void;
    warn?: (message: string) => void;
}

function defaultReadBootstrapSql(sqlPath: string): string | null {
    if (!fs.existsSync(sqlPath)) return null;
    return fs.readFileSync(sqlPath, 'utf8');
}

/** The `books` table is the marker for an initialized GnuCash schema. */
async function schemaIsInitialized(query: BootstrapQuery): Promise<boolean> {
    const result = await query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'books' LIMIT 1"
    );
    return Boolean(result.rowCount);
}

/**
 * Bootstrap policy:
 *   - Empty database (fresh install): apply bootstrap.sql, generated at
 *     image-build time via `prisma migrate diff --from-empty`, to create
 *     the base GnuCash tables and extension tables.
 *   - Existing database: skip the bootstrap. initializeDatabase() owns
 *     ongoing schema sync via idempotent DDL.
 *
 * Concurrency: the app and worker containers start together and both run this.
 * The emptiness check and the multi-statement `bootstrap.sql` used to run with
 * no lock at all, so on a fresh install both containers saw an empty database
 * and both replayed the DDL — the loser failing partway through with
 * "relation already exists" and taking its container down with it. The check is
 * now repeated *inside* the advisory lock, which is the only place its answer
 * is still true by the time we act on it.
 *
 * The unlocked pre-check is kept purely as a fast path: on every restart after
 * the first, the database is already initialized and there is no reason to
 * queue behind the schema lock to learn that.
 */
export async function bootstrapIfEmpty(
    query: BootstrapQuery,
    withLock: BootstrapLock,
    options: BootstrapOptions = {}
): Promise<BootstrapOutcome> {
    const log = options.log ?? console.log;
    const warn = options.warn ?? console.warn;
    const readSql = options.readBootstrapSql ?? defaultReadBootstrapSql;
    const sqlPath = options.sqlPath ?? path.join(process.cwd(), 'bootstrap.sql');

    if (await schemaIsInitialized(query)) {
        log('Existing database detected - skipping schema bootstrap');
        return 'existing';
    }

    return withLock(SCHEMA_BOOTSTRAP_LOCK, async () => {
        if (await schemaIsInitialized(query)) {
            log('Database was bootstrapped by another container while waiting - skipping');
            return 'existing-after-lock';
        }

        const sql = readSql(sqlPath);
        if (sql === null) {
            warn(`Empty database but no bootstrap.sql at ${sqlPath} - relying on db-init only`);
            return 'missing-sql';
        }

        log('Empty database detected - applying bootstrap.sql');
        // node-postgres runs multi-statement strings via the simple query protocol.
        await query(sql);
        log('✓ Schema bootstrap complete');
        return 'bootstrapped';
    });
}
