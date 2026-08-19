import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

// Pin workers before Vitest starts them. `test.env` alone is applied too late
// for Node's timezone-aware Date implementation.
process.env.TZ = process.env.VITEST_TZ ?? 'America/Los_Angeles';

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: [
      'node_modules',
      '.next',
      'dist',
      // The integration tier needs a real PostgreSQL database and runs from
      // vitest.integration.config.ts instead. Without this exclusion those
      // files would be picked up by the pattern above and fail at import for
      // every developer and every CI run that has no TEST_DATABASE_URL, which
      // is the default and correct state for the unit tier.
      'src/**/*.integration.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      // This proof provisions its own Docker PostgreSQL instance, so it has a
      // dedicated node-only config rather than inheriting this jsdom setup.
      'src/**/*.docker.test.ts',
    ],
    coverage: {
      provider: 'v8',
      // lcov + json-summary are what CI archives; text/html are for humans.
      reporter: ['text', 'text-summary', 'json', 'json-summary', 'lcov', 'html'],
      // Without this the report is dropped whenever a single test fails, so a
      // red CI run uploads an empty coverage artifact - exactly the run where
      // you most want to see what was exercised.
      reportOnFailure: true,
      exclude: [
        'node_modules/',
        'src/__tests__/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/types.ts',
      ],
      // A regression floor, not a target. Measured 2026-08-19 at
      // 61.66 / 51.73 / 58.41 / 63.29 (statements / branches / functions /
      // lines) over 5792 unit tests; each floor sits a few points under that
      // so ordinary churn does not turn CI red, while deleting or bypassing a
      // meaningful body of tests does. Raise these when the real numbers move
      // up - never lower them to make a build pass.
      thresholds: {
        statements: 58,
        branches: 48,
        functions: 55,
        lines: 60,
      },
    },
  },
});
