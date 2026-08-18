import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * The self-contained Prisma deadlock proof does not use TEST_DATABASE_URL.
 * It starts and removes a PostgreSQL container through docker's explicit
 * `default` context, so it must not inherit either the jsdom unit setup or the
 * shared-database integration setup.
 */
export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        environment: 'node',
        globals: true,
        include: ['src/__tests__/prisma-deadlock-oracle.docker.test.ts'],
        fileParallelism: false,
        maxWorkers: 1,
        minWorkers: 1,
        testTimeout: 30_000,
        hookTimeout: 60_000,
    },
});
