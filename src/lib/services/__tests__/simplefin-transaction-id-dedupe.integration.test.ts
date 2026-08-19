/**
 * Real-PostgreSQL proof that SimpleFIN's primary feed id stays unique even
 * when its optional partial unique index is absent.
 *
 * The fixture is wholly run-scoped and cleanup asserts exact zero residue;
 * this tier may target a shared, long-lived test database, so it never
 * truncates a table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hasTestDatabaseUrl, requireTestDatabaseUrl } from '@/__tests__/integration/env';

const TEST_DATABASE_URL = hasTestDatabaseUrl() ? requireTestDatabaseUrl() : null;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const describeWithDatabase = describe.skipIf(!TEST_DATABASE_URL);
const RUN = randomUUID().replace(/-/g, '');
const SIMPLEFIN_ID = `itest-simplefin-lock-${RUN}`;
const TRANSACTION_GUIDS = [
  `${RUN.slice(0, 31)}a`,
  `${RUN.slice(0, 31)}b`,
];
const DB_TIMEOUT_MS = 60_000;

describeWithDatabase(
  'SimpleFIN primary-id dedupe without uq_txn_meta_simplefin_id',
  () => {
    let pool: Pool;
    let prisma: (typeof import('@/lib/prisma'))['default'];
    let claimSimpleFinTransactionId: (typeof import('../simplefin-sync.service'))['claimSimpleFinTransactionId'];

    beforeAll(async () => {
      pool = new Pool({ connectionString: TEST_DATABASE_URL!, max: 3 });
      // The production guard deliberately skips the index for dirty books.
      // Remove it here to exercise that exact fallback state.
      await pool.query('DROP INDEX IF EXISTS uq_txn_meta_simplefin_id');
      ({ default: prisma } = await import('@/lib/prisma'));
      ({ claimSimpleFinTransactionId } = await import('../simplefin-sync.service'));
      await Promise.all([
        prisma.$queryRaw`SELECT 1`,
        prisma.$queryRaw`SELECT 1`,
      ]);
    }, DB_TIMEOUT_MS);

    afterAll(async () => {
      if (!pool) return;
      try {
        await prisma?.$disconnect();
        await pool.query(
          'DELETE FROM gnucash_web_transaction_meta WHERE simplefin_transaction_id = $1',
          [SIMPLEFIN_ID],
        );
        const residue = await pool.query<{ n: number }>(
          'SELECT COUNT(*)::int AS n FROM gnucash_web_transaction_meta WHERE simplefin_transaction_id = $1',
          [SIMPLEFIN_ID],
        );
        expect(residue.rows[0].n).toBe(0);
        // Cleanup restored the clean state, so leave the useful index behind
        // for any following integration files.
        await pool.query(
          'CREATE UNIQUE INDEX IF NOT EXISTS uq_txn_meta_simplefin_id ON gnucash_web_transaction_meta (simplefin_transaction_id) WHERE simplefin_transaction_id IS NOT NULL',
        );
      } finally {
        await pool.end();
      }
    }, DB_TIMEOUT_MS);

    it('serializes two real database connections and permits exactly one insert', async () => {
      // Block metadata reads after the first racer has claimed the named
      // transaction-id lock. The second racer then waits on that advisory
      // lock, proving this uses two concurrent PostgreSQL transactions rather
      // than a process-local fake.
      const gate = await pool.connect();
      await gate.query('BEGIN');
      await gate.query('LOCK TABLE gnucash_web_transaction_meta IN ACCESS EXCLUSIVE MODE');

      const racers = TRANSACTION_GUIDS.map(transactionGuid =>
        prisma.$transaction(async tx => {
          const pid = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
          const claimed = await claimSimpleFinTransactionId(tx, SIMPLEFIN_ID);
          if (claimed) {
            await tx.gnucash_web_transaction_meta.create({
              data: {
                transaction_guid: transactionGuid,
                source: 'simplefin',
                reviewed: false,
                simplefin_transaction_id: SIMPLEFIN_ID,
              },
            });
          }
          return { claimed, pid: pid[0].pid };
        }, { timeout: DB_TIMEOUT_MS }),
      );
      racers.forEach(racer => { void racer.catch(() => {}); });

      // Give both checked-out connections time to reach their contended SQL.
      await new Promise(resolve => setTimeout(resolve, 100));
      await gate.query('COMMIT');
      gate.release();

      const outcomes = await Promise.all(racers);
      expect(new Set(outcomes.map(outcome => outcome.pid)).size).toBe(2);
      expect(outcomes.filter(outcome => outcome.claimed)).toHaveLength(1);

      const count = await pool.query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM gnucash_web_transaction_meta WHERE simplefin_transaction_id = $1',
        [SIMPLEFIN_ID],
      );
      expect(count.rows[0].n).toBe(1);
    }, DB_TIMEOUT_MS);
  },
);
