/**
 * Dev helper: run initializeDatabase() against the database in env
 * (pass env via: npx tsx --env-file=.env.local scripts/dev-run-db-init.ts).
 * Validates and applies the extension-table DDL outside of app startup.
 */
import { initializeDatabase } from '../src/lib/db-init';

initializeDatabase()
    .then(() => {
        console.log('db-init run complete');
        process.exit(0);
    })
    .catch((err) => {
        console.error('db-init run failed:', err);
        process.exit(1);
    });
