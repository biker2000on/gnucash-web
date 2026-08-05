import fs from 'node:fs';
import path from 'node:path';
import { validateStartupEnvironment } from '../src/lib/startup-env';

type QueryFn = typeof import('../src/lib/db').query;

/**
 * Bootstrap policy:
 *   - Empty database (fresh install): apply bootstrap.sql, generated at
 *     image-build time via `prisma migrate diff --from-empty`, to create
 *     the base GnuCash tables and extension tables.
 *   - Existing database: skip the bootstrap. initializeDatabase() owns
 *     ongoing schema sync via idempotent DDL.
 * The `books` table is the marker for an initialized GnuCash schema.
 */
async function bootstrapIfEmpty(query: QueryFn) {
    const result = await query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'books' LIMIT 1"
    );
    if (result.rowCount) {
        console.log('Existing database detected - skipping schema bootstrap');
        return;
    }

    const sqlPath = path.join(process.cwd(), 'bootstrap.sql');
    if (!fs.existsSync(sqlPath)) {
        console.warn(`Empty database but no bootstrap.sql at ${sqlPath} - relying on db-init only`);
        return;
    }

    console.log('Empty database detected - applying bootstrap.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    // node-postgres runs multi-statement strings via the simple query protocol.
    await query(sql);
    console.log('✓ Schema bootstrap complete');
}

async function main() {
    // Validate before importing database modules so an absent URL/secret fails
    // with the exact variable name instead of a localhost connection error or
    // a request-time session failure.
    validateStartupEnvironment();
    const [{ query }, { initializeDatabase }] = await Promise.all([
        import('../src/lib/db'),
        import('../src/lib/db-init'),
    ]);
    await bootstrapIfEmpty(query);
    // initializeDatabase() rethrows on a structural failure, so this can now
    // actually reject — which is the point: a half-migrated schema must stop
    // the container rather than let the app serve traffic against it.
    await initializeDatabase();
    process.exit(0);
}

main().catch((err) => {
    console.error('db-init failed:', err);
    process.exit(1);
});
