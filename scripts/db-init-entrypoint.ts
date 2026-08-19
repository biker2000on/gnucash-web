import { validateStartupEnvironment } from '../src/lib/startup-env';
import { bootstrapIfEmpty } from '../src/lib/db-bootstrap';

async function main() {
    // Validate before importing database modules so an absent URL/secret fails
    // with the exact variable name instead of a localhost connection error or
    // a request-time session failure.
    validateStartupEnvironment();
    const [{ query, withDatabaseAdvisoryLock }, { initializeDatabase }] = await Promise.all([
        import('../src/lib/db'),
        import('../src/lib/db-init'),
    ]);
    // Serialized against every other container running this same entrypoint:
    // bootstrapIfEmpty re-checks emptiness inside the advisory lock, so on a
    // fresh install exactly one container applies bootstrap.sql.
    await bootstrapIfEmpty(query, withDatabaseAdvisoryLock);
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
