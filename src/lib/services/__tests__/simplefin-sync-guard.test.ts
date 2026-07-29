/**
 * SimpleFin sync concurrency guards:
 *  - per-connection advisory-lock guard (sync-in-progress → clean early exit)
 *  - unique-violation classifier for the simplefin_transaction_id dedup index
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tryWithDatabaseAdvisoryLock: vi.fn(),
}));

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual, tryWithDatabaseAdvisoryLock: mocks.tryWithDatabaseAdvisoryLock };
});

import { isSimpleFinDuplicateViolation, syncSimpleFin } from '../simplefin-sync.service';

describe('syncSimpleFin advisory-lock guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exits early with a clean alreadyRunning result when another sync holds the lock', async () => {
    mocks.tryWithDatabaseAdvisoryLock.mockResolvedValue({ acquired: false });

    const result = await syncSimpleFin(7, 'b'.repeat(32), { source: 'manual' });

    expect(mocks.tryWithDatabaseAdvisoryLock).toHaveBeenCalledWith(
      'gnucash-web:simplefin-sync:7',
      expect.any(Function),
    );
    expect(result.alreadyRunning).toBe(true);
    expect(result.status).toBe('success');
    expect(result.fatal).toBe(false);
    expect(result.transactionsImported).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].warning).toMatch(/already running/i);
  });

  it('returns the inner sync result unchanged when the lock is acquired', async () => {
    const sentinel = { status: 'success', transactionsImported: 3 };
    mocks.tryWithDatabaseAdvisoryLock.mockResolvedValue({ acquired: true, result: sentinel });

    const result = await syncSimpleFin(9, 'b'.repeat(32));

    expect(result).toBe(sentinel);
  });
});

describe('isSimpleFinDuplicateViolation', () => {
  it('recognizes Prisma P2002 targeting the simplefin id index', () => {
    const err = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: 'uq_txn_meta_simplefin_id' },
    });
    expect(isSimpleFinDuplicateViolation(err)).toBe(true);
  });

  it('recognizes Postgres 23505 text mentioning the simplefin id column', () => {
    const err = new Error(
      'duplicate key value violates unique constraint "uq_txn_meta_simplefin_id" (simplefin_transaction_id)',
    );
    expect(isSimpleFinDuplicateViolation(err)).toBe(true);
  });

  it('rejects unique violations on other keys', () => {
    const err = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: 'uq_prices_commodity_currency_date' },
    });
    expect(isSimpleFinDuplicateViolation(err)).toBe(false);
  });

  it('rejects unrelated errors and non-errors', () => {
    expect(isSimpleFinDuplicateViolation(new Error('connection refused'))).toBe(false);
    expect(isSimpleFinDuplicateViolation(null)).toBe(false);
    expect(isSimpleFinDuplicateViolation(undefined)).toBe(false);
    // Mentions the column but is not a unique violation
    expect(isSimpleFinDuplicateViolation(new Error('simplefin_transaction_id is null'))).toBe(false);
  });
});
