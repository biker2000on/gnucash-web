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
