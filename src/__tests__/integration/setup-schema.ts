/**
 * Creates the schema the integration tier runs against, in TEST_DATABASE_URL.
 *
 *   npm run test:integration:schema
 *
 * Run it once per EMPTY database. CI runs this exact script against its
 * postgres service, which is the point: the local and CI paths to a usable
 * database are the same two steps, not two things that drift. CI gets an empty
 * database for free - the service container is new for every job.
 *
 * IT IS NOT RE-RUNNABLE, and that is a property of `prisma db push`, not a
 * missing feature here. Step 2 below creates 20 tables that prisma/schema.prisma
 * does not model, so on a second run `db push` reads them as drift and asks to
 * DROP them; because they hold rows by then it refuses outright rather than
 * doing it. That refusal is the safe outcome and is deliberately left in place:
 * silencing it with --accept-data-loss would mean a mistyped TEST_DATABASE_URL
 * drops 20 tables out of whatever database it actually landed on. To re-provision,
 * drop and recreate the database, then run this again.
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
 *
 * WHAT THIS SCRIPT DOES NOT DO: it never drops, truncates or otherwise removes
 * data. It only adds schema. Rows written by the tier are cleaned up by the
 * test file that wrote them - see the TEST DATA section of
 * vitest.integration.config.ts. To start genuinely clean, drop and recreate the
 * database and run this script again.
 */
import { execSync } from 'node:child_process';
import { requireTestDatabaseUrl } from './env';

async function main(): Promise<void> {
    const url = requireTestDatabaseUrl();

    // Both halves read DATABASE_URL: prisma.config.ts passes it through as the
    // datasource, and src/lib/db.ts builds its pool from it at import time.
    // Setting it here is what aims them at the test database.
    process.env.DATABASE_URL = url;

    // Deliberately does not echo the connection URL, redacted or otherwise. CI
    // step logs are retained and readable by everyone with repository access,
    // and a password-stripped URL still publishes the username, host, port,
    // database name and any query-string parameters - which is inventory, not
    // diagnostics. Whoever ran this already knows where TEST_DATABASE_URL
    // points; `prisma db push` prints its own datasource line below if the
    // target is genuinely in question.
    console.log('Creating integration schema in the TEST_DATABASE_URL database.');

    console.log('\n== prisma db push (modelled tables) ==');
    // No --skip-generate: Prisma 7 removed that flag from `db push` (it exits
    // with "unknown or unexpected option") because the command no longer runs
    // the generator implicitly. The datasource comes from prisma.config.ts,
    // which reads DATABASE_URL - set just above.
    try {
        execSync('npx prisma db push', { stdio: 'inherit' });
    } catch {
        // Overwhelmingly this is the re-run case described in the header: the
        // database already went through step 2, and db push wants to drop the
        // tables only step 2 knows about. The raw prisma output above says
        // "use --accept-data-loss", which is the one thing nobody should do
        // here, so say what to do instead before exiting.
        throw new Error(
            [
                '`prisma db push` failed.',
                '',
                'If it reported dropping gnucash_web_* tables, this database has',
                'already been provisioned: the script targets an EMPTY database and',
                'cannot be re-run against a populated one. Do NOT pass',
                '--accept-data-loss - drop and recreate the database, then run',
                'npm run test:integration:schema again.',
            ].join('\n'),
        );
    }

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
