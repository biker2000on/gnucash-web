/**
 * Creates the schema the integration tier runs against, in TEST_DATABASE_URL.
 *
 *   npm run test:integration:schema
 *
 * Run it once per throwaway database; it is idempotent, so re-running is safe.
 * CI runs this exact script against its postgres service, which is the point:
 * the local and CI paths to a usable database are the same two steps, not two
 * things that drift.
 *
 * WHY TWO STEPS. The schema this app runs on has two halves and neither one
 * alone is enough:
 *
 *   1. `prisma db push` creates the 87 models in prisma/schema.prisma - the
 *      core GnuCash tables (accounts, splits, transactions, lots, ...) plus the
 *      63 gnucash_web_* extension tables that are modelled there. Measured
 *      against an empty database: 87 tables, 0 views.
 *   2. initializeDatabase() adds 20 further tables and all 9 views, all of
 *      which exist ONLY as idempotent DDL in src/lib/db-init.ts and the schema
 *      modules it imports. Prisma has never seen them, so db push cannot
 *      create them: account_hierarchy, gnucash_web_schema_meta and
 *      gnucash_web_webhook_idempotency are all in this group. Measured total
 *      after both steps: 107 tables, 9 views.
 *
 * A third group - 31 tables such as gnucash_web_share_links, gnucash_web_totp
 * and gnucash_web_report_schedules - is created by neither, and is instead
 * provisioned by per-feature ensureXTable() helpers on first use. Those are
 * left alone here on purpose: the helpers are CREATE TABLE IF NOT EXISTS
 * behind an advisory lock, so a test that touches such a feature provisions it
 * the same way production does, and the harness exercises that path rather
 * than hiding it behind a pre-baked schema.
 *
 * Ordering matters: db-init builds account_hierarchy over `accounts`, so the
 * Prisma push has to land first.
 */
import { execSync } from 'node:child_process';
import { redactDatabaseUrl, requireTestDatabaseUrl } from './env';

async function main(): Promise<void> {
    const url = requireTestDatabaseUrl();

    // Both halves read DATABASE_URL: prisma.config.ts passes it through as the
    // datasource, and src/lib/db.ts builds its pool from it at import time.
    // Setting it here is what aims them at the test database.
    process.env.DATABASE_URL = url;

    console.log(`Creating integration schema in ${redactDatabaseUrl(url)}`);

    console.log('\n== prisma db push (modelled tables) ==');
    // No --skip-generate: Prisma 7 removed that flag from `db push` (it exits
    // with "unknown or unexpected option") because the command no longer runs
    // the generator implicitly. The datasource comes from prisma.config.ts,
    // which reads DATABASE_URL - set just above.
    execSync('npx prisma db push', { stdio: 'inherit' });

    console.log('\n== initializeDatabase (views + unmodelled extension tables) ==');
    // Imported dynamically, AFTER DATABASE_URL is set: src/lib/db.ts opens its
    // pool during module evaluation, so a static import would capture whatever
    // DATABASE_URL happened to be at process start.
    const { initializeDatabase } = await import('../../lib/db-init');
    await initializeDatabase();

    console.log('\nIntegration schema ready.');
    // The app pool has no exported close, and its idle clients would keep the
    // event loop alive. Same exit strategy as scripts/dev-run-db-init.ts.
    process.exit(0);
}

main().catch((err) => {
    console.error('\nIntegration schema setup failed:');
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
