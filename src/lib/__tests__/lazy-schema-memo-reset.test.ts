/**
 * Lazy-schema `ensure*Table()` helpers memoize their DDL promise at module
 * scope. Without a reset on rejection, ONE transient DB error (a Postgres
 * restart, a pool blip) permanently disables every write to that table for the
 * life of the process — the memo keeps handing back the same rejected promise
 * even after the database is healthy again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeRawUnsafe: vi.fn(),
  queryRawUnsafe: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    $executeRawUnsafe: mocks.executeRawUnsafe,
    $queryRawUnsafe: mocks.queryRawUnsafe,
  },
}));
vi.mock('@/lib/db', () => ({
  query: mocks.query,
  withDatabaseAdvisoryLock: vi.fn(),
  tryWithDatabaseAdvisoryLock: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

/** Every lazy-schema helper this agent touched, keyed by its module path. */
const HELPERS: Array<[string, () => Promise<{ ensure: () => Promise<void> }>]> = [
  ['statement.service', async () => ({
    ensure: (await import('../services/statement.service')).ensureStatementTables,
  })],
  ['backup', async () => ({ ensure: (await import('../backup')).ensureBackupsTable })],
  ['emergency-info', async () => ({
    ensure: (await import('../emergency-info')).ensureEmergencyInfoTables,
  })],
  ['notifications', async () => ({
    ensure: (await import('../notifications')).ensureNotificationsTable,
  })],
  ['webhook-idempotency', async () => ({
    ensure: (await import('../webhook-idempotency')).ensureWebhookIdempotencyTable,
  })],
  ['avg-basis-history', async () => ({
    ensure: (await import('../avg-basis-history')).ensureAvgBasisHistoryTable,
  })],
];

describe.each(HELPERS)('%s ensure memo', (_name, load) => {
  it('retries after a transient failure instead of poisoning the memo', async () => {
    mocks.executeRawUnsafe
      .mockRejectedValueOnce(new Error('terminating connection due to administrator command'))
      .mockResolvedValue(0);
    mocks.query
      .mockRejectedValueOnce(new Error('terminating connection due to administrator command'))
      .mockResolvedValue({ rows: [] });

    const { ensure } = await load();

    await expect(ensure()).rejects.toThrow();
    // Same process, database healthy again: the next call must actually retry.
    await expect(ensure()).resolves.toBeUndefined();
  });
});
