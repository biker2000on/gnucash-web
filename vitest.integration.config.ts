import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Integration tier - the tests that need a REAL PostgreSQL database.
 *
 * Kept as a separate config rather than a mode flag on the default one because
 * almost nothing is shared: this tier runs in node (not jsdom), uses its own
 * setup file, and must not load the DOM mocks. The default config excludes the
 * same filename pattern this one includes, so the two tiers partition the
 * suite with no overlap and no file counted twice.
 *
 *   npm run test:run          -> everything EXCEPT *.integration.test.ts
 *   npm run test:integration  -> ONLY *.integration.test.ts
 *
 * There is no react() plugin here: these tests exercise server-side data
 * access, not components.
 *
 * ## TEST DATA IS THE TEST FILE'S RESPONSIBILITY
 *
 * This tier runs against whatever TEST_DATABASE_URL points at, AS IT FINDS IT.
 * It deliberately does not create a per-run schema and does not truncate
 * anything, in either direction:
 *
 *   - no globalSetup creating/dropping a schema per run, because CI's postgres
 *     service is already a fresh container per job and locally the same
 *     throwaway database is reused all day - a drop would mean re-running the
 *     two-step `test:integration:schema` bootstrap on every invocation;
 *   - no blanket TRUNCATE, because "the tier wipes the database it is pointed
 *     at" is a footgun aimed squarely at whoever mistypes TEST_DATABASE_URL.
 *
 * So a test that WRITES must clean up after itself, or it leaves residue that
 * the next run sees. The convention, worked through in
 * src/__tests__/integration/locking.integration.test.ts:
 *
 *   1. tag every written row with a per-run id (a uuid, not a fixed literal),
 *      so two runs and any leftovers cannot collide;
 *   2. delete exactly those rows in afterAll, scoped by that id.
 *
 * If a future test needs isolation stronger than that - say it must observe an
 * empty table - give it its OWN schema (CREATE SCHEMA ... ; SET search_path)
 * inside that test file rather than making the whole tier destructive.
 */
export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        environment: 'node',
        globals: true,
        setupFiles: ['./src/__tests__/integration/setup.ts'],
        include: ['src/**/*.integration.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
        exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**'],
        // One shared database, so files do not run concurrently: two files
        // truncating or locking the same rows would produce failures that look
        // like the code under test misbehaving. Tests within a file may still
        // run concurrent connections - that is the entire point of the tier.
        fileParallelism: false,
        // Round trips to a real server, plus deliberate lock contention where a
        // test is waiting for another connection to commit.
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
