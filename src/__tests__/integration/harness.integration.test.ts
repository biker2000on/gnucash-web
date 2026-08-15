/**
 * Self-test for the integration harness itself.
 *
 * This asserts nothing about application behaviour. Its only job is to make
 * the tier's own failure modes loud, because the tier's whole value is that it
 * really runs: a `test:integration` step that passes with zero executed
 * assertions is indistinguishable in a CI log from one that verified
 * something, and that is exactly the false confidence this harness exists to
 * remove. If the postgres service, the schema steps, or the env plumbing in
 * .github/workflows/deploy.yml ever get dropped, this file goes red.
 *
 * Deliberately NOT covered here: lock ordering, FOR UPDATE, and the
 * reconciled-split guard. Those are the tests the harness was built FOR, and
 * they land separately.
 */
import { describe, expect, it } from 'vitest';
import { getTestPool, withTestClient } from './db';
import { requireTestDatabaseUrl } from './env';

/** Whether a relation (table or view) exists in the search path. */
async function relationExists(name: string): Promise<boolean> {
    const result = await getTestPool().query('SELECT to_regclass($1) AS oid', [name]);
    return result.rows[0]?.oid !== null;
}

describe('integration harness', () => {
    it('reaches a real PostgreSQL server', async () => {
        const result = await getTestPool().query('SELECT version() AS version');
        expect(result.rows[0].version).toContain('PostgreSQL');
    });

    it('points application code at the test database, not DATABASE_URL', async () => {
        // The setup file overwrites DATABASE_URL so that src/lib/db.ts - and
        // every service that goes through it - lands on the throwaway database.
        // If this ever regresses, integration tests would write to whatever
        // book the developer had configured.
        expect(process.env.DATABASE_URL).toBe(requireTestDatabaseUrl());
    });

    it('has the core GnuCash tables from prisma db push', async () => {
        // These are modelled in prisma/schema.prisma, so their absence means
        // the `prisma db push` step did not run or did not target this database.
        for (const table of ['accounts', 'transactions', 'splits', 'books']) {
            expect(await relationExists(table), `missing table: ${table}`).toBe(true);
        }
    });

    it('has the objects only initializeDatabase() creates', async () => {
        // None of these exist in prisma/schema.prisma. They come from
        // src/lib/db-init.ts, so their absence means the schema step ran the
        // Prisma half and skipped db-init - the failure mode that would
        // otherwise surface much later as a confusing "relation does not
        // exist" inside an unrelated test.
        expect(await relationExists('account_hierarchy'), 'missing view: account_hierarchy').toBe(
            true,
        );
        for (const table of ['gnucash_web_schema_meta', 'gnucash_web_webhook_idempotency']) {
            expect(await relationExists(table), `missing table: ${table}`).toBe(true);
        }
    });

    it('can hold two independent connections at once', async () => {
        // The capability the tier exists to provide. Concurrency guarantees -
        // lock ordering, FOR UPDATE, advisory locks - are only observable from
        // a second connection watching the first, which a mocked pool cannot
        // do at any level of effort.
        await withTestClient(async (first) => {
            await withTestClient(async (second) => {
                const [a, b] = await Promise.all([
                    first.query('SELECT pg_backend_pid() AS pid'),
                    second.query('SELECT pg_backend_pid() AS pid'),
                ]);
                expect(a.rows[0].pid).not.toBe(b.rows[0].pid);
            });
        });
    });
});
