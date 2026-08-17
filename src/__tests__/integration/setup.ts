/**
 * Vitest setup for the integration tier (vitest.integration.config.ts).
 *
 * Deliberately NOT src/__tests__/setup.ts: that file mocks window, matchMedia,
 * localStorage and IntersectionObserver for jsdom. The integration tier runs
 * in the node environment against a real database, where none of those exist
 * and none of them are wanted.
 *
 * Runs before every integration test file, and fails the file at setup time
 * when TEST_DATABASE_URL is missing. See ./env.ts for why that is a failure
 * and not a skip.
 */
import { afterAll } from 'vitest';
import { requireTestDatabaseUrl } from './env';
import { closeTestPool } from './db';

const testDatabaseUrl = requireTestDatabaseUrl();

// Point the application's own pool (src/lib/db.ts reads DATABASE_URL at import
// time) at the test database. This is an unconditional overwrite: a developer
// with DATABASE_URL aimed at their real book must not have integration tests
// write to it, and the safe direction is to always prefer TEST_DATABASE_URL.
process.env.DATABASE_URL = testDatabaseUrl;

// session-config.ts refuses to load without a secret. Same throwaway value the
// unit setup uses - tests must never depend on deployment configuration.
process.env.SESSION_SECRET ||= 'test-only-session-secret-not-used-in-any-deployment';

// GnuCash numeric columns come back as BigInt; JSON.stringify throws on those.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
    return this.toString();
};

// Per test file: release sockets so the worker can exit.
afterAll(async () => {
    await closeTestPool();
});
