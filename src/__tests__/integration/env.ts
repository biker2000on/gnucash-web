/**
 * Integration-tier environment resolution.
 *
 * The integration tier talks to a REAL PostgreSQL database. Everything that
 * needs its URL - the vitest setup file, the schema bootstrap script, and the
 * pool helper - resolves it through here so there is exactly one place that
 * decides where the tier points and exactly one error message when it cannot.
 *
 * Resolution order:
 *   1. TEST_DATABASE_URL already in the process environment (this is what CI
 *      sets, and it must win so a stray local file cannot redirect a CI run).
 *   2. TEST_DATABASE_URL in .env.test.local at the repository root. That file
 *      is gitignored (.gitignore ignores .env*), so credentials stay off the
 *      branch - see the README testing section for the expected contents.
 *
 * There is deliberately no third step. When neither supplies a URL the tier
 * FAILS rather than skipping: a tier that quietly skips reports green while
 * asserting nothing, which is worse than having no tier at all because it
 * looks like coverage.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as dotenv from 'dotenv';

/** Repo-root file a developer puts their throwaway database URL in. */
export const TEST_ENV_FILE = '.env.test.local';

/**
 * Actionable failure text. Exported so tests can assert on it and so the
 * schema script and the vitest setup file cannot drift into two different
 * explanations of the same problem.
 */
export const MISSING_TEST_DATABASE_URL_MESSAGE = [
    'TEST_DATABASE_URL is not set, so the integration tier cannot run.',
    '',
    'This tier requires a real PostgreSQL database and never falls back to a',
    'mock or a skip - a silently skipped tier looks like coverage it does not',
    'have.',
    '',
    'Locally:',
    '  1. Create a throwaway database. NEVER point this at a real book; the',
    '     tier is free to write to it.',
    `  2. Put the URL in ${TEST_ENV_FILE} at the repository root (gitignored):`,
    '       TEST_DATABASE_URL=postgresql://user:password@localhost:5432/gnucash_test',
    '  3. Create the schema once:  npm run test:integration:schema',
    '  4. Run the tier:            npm run test:integration',
    '',
    'In CI: the postgres service in the `quality` job of',
    '.github/workflows/deploy.yml supplies this. Seeing this message there',
    'means the service block or its env: mapping was dropped.',
].join('\n');

let loaded = false;

/**
 * Loads .env.test.local into process.env if it exists. Idempotent, and never
 * overrides variables already present - dotenv's default - so CI's real
 * environment always beats a file that happens to be lying around.
 */
export function loadTestEnvFile(): void {
    if (loaded) return;
    loaded = true;
    const envPath = path.resolve(process.cwd(), TEST_ENV_FILE);
    if (existsSync(envPath)) {
        dotenv.config({ path: envPath, quiet: true });
    }
}

/**
 * Non-throwing probe for the same variable {@link requireTestDatabaseUrl}
 * requires.
 *
 * The tier as a whole still hard-fails without a database (see the header) -
 * that policy lives in the setup file. This exists so an individual test file
 * can additionally guard its own `describe` with `describe.skipIf`, which
 * keeps the decision out of module scope: a file that throws while being
 * imported takes the whole run down with a stack trace instead of a skip, and
 * that failure mode is not worth having in a file whose only job is asserting
 * lock behaviour.
 */
export function hasTestDatabaseUrl(): boolean {
    loadTestEnvFile();
    return Boolean(process.env.TEST_DATABASE_URL?.trim());
}

/**
 * Returns the integration database URL, or throws with the message above.
 *
 * @throws Error when TEST_DATABASE_URL is absent or blank.
 */
export function requireTestDatabaseUrl(): string {
    loadTestEnvFile();
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error(MISSING_TEST_DATABASE_URL_MESSAGE);
    return url;
}

// There is deliberately no redactDatabaseUrl() here. Password-stripping a
// connection URL so it can be printed still publishes the username, host,
// port, database name and query-string parameters into retained CI logs, and
// nothing in this tier needs to print the URL at all - see setup-schema.ts.
